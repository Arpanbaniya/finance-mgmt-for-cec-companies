import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { z } from "zod";
import { DomainError } from "@/domain/errors";
import { canonicalJSON, contentHash, type JsonValue } from "@/domain/approvals";
import { withScope } from "@/features/identity/scope";
import { audit } from "@/features/platform/service";
import { enqueuePolicyActivation } from "@/features/jobs/outbox";
import { replay, remember } from "@/features/platform/idempotency";
import { ApprovalPolicyCreate, ApprovalPolicyDTO, AuditEventDTO, AuditQuery, CommandResult, Transition } from "./contracts";

type Row = Record<string, unknown>;
function dto(row: Row) {
  return ApprovalPolicyDTO.parse({ ...(row.definition as object), id: row.id, organizationId: row.organization_id, entityId: row.legal_entity_id,
    status: row.status, version: row.version, contentHash: row.content_hash, createdBy: row.created_by, createdAt: (row.created_at as Date).toISOString(),
    activatedBy: row.activated_by, activatedAt: row.activated_at ? (row.activated_at as Date).toISOString() : null, activationReason: row.activation_reason });
}
async function selected(client: PoolClient, org: string, entity: string, id: string, lock = false) {
  const result = await client.query(`SELECT * FROM approval_policies WHERE organization_id=$1 AND legal_entity_id=$2 AND id=$3${lock ? " FOR UPDATE" : ""}`, [org, entity, id]);
  if (!result.rowCount) throw new DomainError("NOT_FOUND", "Approval policy is unavailable.", 404);
  return result.rows[0];
}
export async function listPolicies(user: string, org: string, entity: string, limit: number, cursor?: string) {
  return withScope(user, org, entity, "approvals.read", async client => {
    const rows = await client.query("SELECT * FROM approval_policies WHERE organization_id=$1 AND legal_entity_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4", [org, entity, cursor ?? null, limit + 1]);
    const data = rows.rows.slice(0, limit).map(dto); return { data, nextCursor: rows.rows.length > limit ? data.at(-1)!.id : null };
  });
}
export async function getPolicy(user: string, org: string, entity: string, id: string) { return withScope(user, org, entity, "approvals.read", async client => dto(await selected(client, org, entity, id))); }
export async function createPolicy(user: string, org: string, entity: string, input: z.infer<typeof ApprovalPolicyCreate>, key: string, requestId: string) {
  const definition = ApprovalPolicyCreate.parse(input);
  return withScope(user, org, entity, "approvals.create", async client => {
    await client.query("SELECT app_security.lock_policy_scope($1,$2)", [org, entity]);
    if (!(await client.query("SELECT app_security.can_manage_policy($1) AND app_security.can_entity($1,$2) AS allowed", [org, entity])).rows[0].allowed) throw new DomainError("FORBIDDEN", "Policy creation authority is unavailable.", 403);
    const operation = `approval_policy.create:${entity}`, hash = contentHash(definition as JsonValue);
    const prior = await replay(client, org, user, operation, key, hash); if (prior) return ApprovalPolicyDTO.parse(prior);
    const id = randomUUID();
    const inserted = await client.query("INSERT INTO approval_policies(id,organization_id,legal_entity_id,definition,canonical_payload,content_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *", [id, org, entity, JSON.stringify(definition), canonicalJSON(definition as JsonValue), hash, user]);
    const response = dto(inserted.rows[0]);
    await audit(client, org, user, "approval_policy.create", id, requestId, entity);
    await remember(client, org, user, operation, key, hash, id, response); return response;
  });
}
export async function activatePolicy(user: string, org: string, entity: string, id: string, input: z.infer<typeof Transition>, version: number, key: string, requestId: string) {
  const command = Transition.parse(input);
  return withScope(user, org, entity, "approval_policies.activate", async client => {
    await client.query("SELECT app_security.lock_policy_scope($1,$2)", [org, entity]);
    if (!(await client.query("SELECT app_security.can_activate_policy($1) AND app_security.can_entity($1,$2) AS allowed", [org, entity])).rows[0].allowed) throw new DomainError("FORBIDDEN", "Activation requires a designated reviewer with admin or finance authority.", 403);
    const operation = `approval_policy.activate:${entity}`, hash = contentHash({ id, version, ...command });
    let row = await selected(client, org, entity, id);
    if (row.created_by === user) throw new DomainError("SELF_APPROVAL", "A different designated reviewer must activate this policy.", 403);
    row = await selected(client, org, entity, id, true);
    const prior = await replay(client, org, user, operation, key, hash); if (prior) return CommandResult.parse(prior);
    if (row.version !== version) throw new DomainError("STALE_VERSION", "Reload the policy before activating it.", 412);
    if (row.status !== "draft") throw new DomainError("INVALID_TRANSITION", "Only a draft policy can be activated.", 409);
    const overlap = await client.query("SELECT id FROM approval_policies WHERE organization_id=$1 AND legal_entity_id=$2 AND status='active' AND definition->'aggregateTypes' ?| $3::text[] AND daterange((definition->>'effectiveFrom')::date,(definition->>'effectiveTo')::date,'[)') && daterange($4::date,$5::date,'[)')", [org, entity, row.definition.aggregateTypes, row.definition.effectiveFrom, row.definition.effectiveTo ?? null]);
    if (overlap.rowCount) throw new DomainError("POLICY_OVERLAP", "An active policy already covers this action and date range.", 409);
    await client.query("UPDATE approval_policies SET status='active',version=version+1,activated_by=$2,activated_at=now(),activation_reason=$3 WHERE id=$1", [id, user, command.reason ?? null]);
    const response = CommandResult.parse({ resourceId: id, version: version + 1, status: "active", requestId });
    await audit(client, org, user, "approval_policy.activate", id, requestId, entity);
    await enqueuePolicyActivation(client, org, entity, id);
    await remember(client, org, user, operation, key, hash, id, response); return response;
  });
}
export async function listAudit(user: string, org: string, entity: string, input: z.infer<typeof AuditQuery>) {
  const query = AuditQuery.parse(input);
  return withScope(user, org, entity, "audit.read", async client => {
    // Historical setup rows lacked entity scope. Read them narrowly without rewriting append-only history.
    const rows = await client.query(`SELECT * FROM audit_events WHERE organization_id=$1
      AND (legal_entity_id=$2 OR (legal_entity_id IS NULL AND action IN ('entity.create','entity.update') AND target_id=$2))
      AND ($3::uuid IS NULL OR id>$3) AND ($4::text IS NULL OR action=$4) AND ($5::text IS NULL OR split_part(action,'.',1)=$5)
      AND ($6::uuid IS NULL OR target_id=$6) AND ($7::text IS NULL OR actor_id=$7)
      AND ($8::timestamptz IS NULL OR occurred_at >= $8) AND ($9::timestamptz IS NULL OR occurred_at < $9)
      ORDER BY id LIMIT $10`, [org, entity, query.cursor ?? null, query.action ?? null, query.targetType ?? null, query.targetId ?? null, query.actorId ?? null, query.fromInstant ?? null, query.toInstantExclusive ?? null, query.limit + 1]);
    const data = rows.rows.slice(0, query.limit).map(r => AuditEventDTO.parse({ id: r.id, organizationId: org, entityId: entity, actorId: r.actor_id, action: r.action, targetType: r.action.split(".")[0], targetId: r.target_id, requestId: r.request_id, occurredAt: r.occurred_at.toISOString() }));
    return { data, nextCursor: rows.rows.length > query.limit ? data.at(-1)!.id : null };
  });
}
