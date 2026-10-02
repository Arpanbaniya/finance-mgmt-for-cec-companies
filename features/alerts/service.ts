import type { z } from "zod";
import { withScope } from "@/features/identity/scope";
import { DomainError } from "@/domain/errors";
import { contentHash } from "@/domain/approvals";
import { audit } from "@/features/platform/service";
import { replay, remember } from "@/features/platform/idempotency";
import { AlertDTO, AlertCommandResult, Reason } from "./contracts";

export async function listAlerts(user: string, org: string, entity: string, limit: number, cursor?: string) {
  return withScope(user, org, entity, "alerts.read", async client => {
    const rows = await client.query(`SELECT * FROM alerts WHERE organization_id=$1 AND legal_entity_id=$2 AND recipient_id=$3
      AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT $5`, [org, entity, user, cursor ?? null, limit + 1]);
    const data = rows.rows.slice(0, limit).map(row => AlertDTO.parse({ id: row.id, organizationId: org, entityId: entity, kind: "approval_policy.activated", policyId: row.policy_id,
      createdAt: row.created_at.toISOString(), acknowledgedAt: row.acknowledged_at?.toISOString() ?? null, version: row.version }));
    return { data, nextCursor: rows.rows.length > limit ? data.at(-1)!.id : null };
  });
}
export async function acknowledgeAlert(user: string, org: string, entity: string, id: string, input: z.infer<typeof Reason>, version: number, key: string, requestId: string) {
  const command = Reason.parse(input);
  return withScope(user, org, entity, "alerts.update", async client => {
    await client.query("SELECT app_security.lock_policy_scope($1,$2)", [org, entity]);
    if (!(await client.query("SELECT app_security.policy_alert_recipient_eligible($1,$2,$3) AS allowed", [org, entity, user])).rows[0].allowed) throw new DomainError("FORBIDDEN", "Alert access is unavailable.", 403);
    const row = await client.query("SELECT * FROM alerts WHERE id=$1 AND organization_id=$2 AND legal_entity_id=$3 AND recipient_id=$4 FOR UPDATE", [id, org, entity, user]);
    if (!row.rowCount) throw new DomainError("NOT_FOUND", "Alert is unavailable.", 404);
    const operation = `alert.acknowledge:${entity}`, hash = contentHash({ id, version, ...command });
    const prior = await replay(client, org, user, operation, key, hash); if (prior) return AlertCommandResult.parse(prior);
    if (row.rows[0].version !== version) throw new DomainError("STALE_VERSION", "Reload notifications before acknowledging.", 412);
    if (row.rows[0].acknowledged_at) throw new DomainError("INVALID_TRANSITION", "This notification has already been acknowledged.", 409);
    await client.query("UPDATE alerts SET version=version+1,acknowledged_at=clock_timestamp(),acknowledgement_reason=$2 WHERE id=$1", [id, command.reason]);
    const response = AlertCommandResult.parse({ resourceId: id, version: version + 1, status: "acknowledged", requestId });
    await audit(client, org, user, "alert.acknowledge", id, requestId, entity);
    await remember(client, org, user, operation, key, hash, id, response);
    return response;
  });
}
