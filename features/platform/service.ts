import { randomUUID, createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { DomainError } from "@/domain/errors";
import { withScope } from "@/features/identity/scope";
import { EntityDTO, EntityPatch, MembershipDTO, type EntityInput } from "./contracts";
import type { z } from "zod";

type Row = Record<string, unknown>;
export function entityDTO(r: Row) {
  return EntityDTO.parse({ id: r.id, organizationId: r.organization_id, name: r.name, registrationIdentifier: r.registration_identifier, taxIdentifier: r.tax_identifier, baseCurrency: r.base_currency, timezone: r.timezone, activeModes: r.active_modes, reportingProfile: r.reporting_profile, policyStatus: r.policy_status, version: r.version, createdAt: (r.created_at as Date).toISOString(), updatedAt: (r.updated_at as Date).toISOString() });
}
export function memberDTO(r: Row) { return MembershipDTO.parse({ id: r.id, organizationId: r.organization_id, userId: r.user_id, roleIds: r.roles, allowedEntityIds: r.allowed_entity_ids, siteIds: r.site_ids, active: r.active, version: r.version }); }
export async function audit(client: PoolClient, org: string, user: string, action: string, target: string, requestId: string) {
  await client.query("INSERT INTO audit_events(id,organization_id,actor_id,action,target_id,request_id) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), org, user, action, target, requestId]);
}
export async function listEntities(user: string, org: string, limit: number, cursor?: string) {
  return withScope(user, org, null, "entity.read", async client => {
    const rows = await client.query("SELECT * FROM legal_entities WHERE organization_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3", [org, cursor ?? null, limit + 1]);
    const data = rows.rows.slice(0, limit).map(entityDTO);
    return { data, nextCursor: rows.rows.length > limit ? data.at(-1)!.id : null };
  });
}
export async function getEntity(user: string, org: string, entity: string) {
  return withScope(user, org, entity, "entity.read", async client => {
    const r = await client.query("SELECT * FROM legal_entities WHERE organization_id=$1 AND id=$2", [org, entity]);
    if (!r.rowCount) throw new DomainError("NOT_FOUND", "Legal entity is unavailable.", 404);
    return entityDTO(r.rows[0]);
  });
}
export async function createEntity(user: string, org: string, input: EntityInput, key: string, requestId: string) {
  return withScope(user, org, null, "entity.create", async client => {
    // The organization lock serializes grant/creation and idempotency decisions.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [org]);
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const previous = await client.query("SELECT * FROM idempotency_results WHERE organization_id=$1 AND principal_id=$2 AND operation='entity.create' AND key=$3", [org, user, key]);
    if (previous.rowCount) {
      if (previous.rows[0].request_hash !== hash) throw new DomainError("IDEMPOTENCY_CONFLICT", "This key was used with a different request.", 409);
      const existing = await client.query("SELECT * FROM legal_entities WHERE id=$1", [previous.rows[0].resource_id]);
      if (!existing.rowCount) throw new DomainError("NOT_FOUND", "Resource is unavailable.", 404);
      return EntityDTO.parse(previous.rows[0].response);
    }
    const id = randomUUID();
    await client.query("INSERT INTO legal_entities(id,organization_id,name,registration_identifier,tax_identifier,base_currency,timezone,active_modes,reporting_profile,policy_status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [id, org, input.name, input.registrationIdentifier ?? null, input.taxIdentifier ?? null, input.baseCurrency, input.timezone, JSON.stringify(input.activeModes), input.reportingProfile, input.reportingProfile === "demo_accrual" ? "demo" : "review_required", user]);
    // Self-grants are forbidden through runtime membership APIs. A narrowly scoped
    // migration-owned function grants only the entity the admin just created.
    await client.query("SELECT app_security.grant_created_entity($1,$2)", [org, id]);
    await audit(client, org, user, "entity.create", id, requestId);
    const row = await client.query("SELECT * FROM legal_entities WHERE id=$1", [id]);
    const response = entityDTO(row.rows[0]);
    await client.query("INSERT INTO idempotency_results(id,organization_id,principal_id,operation,key,request_hash,resource_id,response) VALUES($1,$2,$3,'entity.create',$4,$5,$6,$7)", [randomUUID(), org, user, key, hash, id, JSON.stringify(response)]);
    return response;
  });
}
export async function patchEntity(user: string, org: string, entity: string, input: z.infer<typeof EntityPatch>, version: number, requestId: string) {
  return withScope(user, org, entity, "entity.update", async client => {
    const selected = await client.query("SELECT * FROM legal_entities WHERE id=$1 FOR UPDATE", [entity]);
    if (!selected.rowCount) throw new DomainError("NOT_FOUND", "Legal entity is unavailable.", 404);
    const old = selected.rows[0];
    if (old.version !== version) throw new DomainError("STALE_VERSION", "Reload the current record before editing.", 412);
    const updated = await client.query("UPDATE legal_entities SET name=$2,registration_identifier=$3,tax_identifier=$4,active_modes=$5,version=version+1,updated_at=now() WHERE id=$1 RETURNING *", [entity, input.name ?? old.name, input.registrationIdentifier ?? old.registration_identifier, input.taxIdentifier ?? old.tax_identifier, JSON.stringify(input.activeModes ?? old.active_modes)]);
    await audit(client, org, user, "entity.update", entity, requestId);
    return entityDTO(updated.rows[0]);
  });
}
