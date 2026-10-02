import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { withScope } from "@/features/identity/scope";

const Lease = z.strictObject({ eventId: z.uuid(), token: z.uuid() });
export type OutboxLease = z.infer<typeof Lease>;

// Must be called in the source transaction, after the policy state transition.
export async function enqueuePolicyActivation(client: PoolClient, org: string, entity: string, policy: string) {
  await client.query(`INSERT INTO outbox_events(id,organization_id,legal_entity_id,kind,policy_id,source_version,source_hash,principal_id,recipient_id)
    SELECT $1,organization_id,legal_entity_id,'approval_policy.activated',id,version,content_hash,activated_by,created_by
    FROM approval_policies WHERE organization_id=$2 AND legal_entity_id=$3 AND id=$4 AND status='active'
    ON CONFLICT(organization_id,legal_entity_id,kind,policy_id,source_version) DO NOTHING`, [randomUUID(), org, entity, policy]);
}
async function authorize(client: PoolClient, org: string, entity: string) {
  // Same lock as membership changes. Recheck AFTER taking it, not before waiting.
  await client.query("SELECT app_security.lock_policy_scope($1,$2)", [org, entity]);
  const allowed = await client.query("SELECT app_security.can_activate_policy($1) AND app_security.can_entity($1,$2) AS allowed", [org, entity]);
  if (!allowed.rows[0].allowed) throw new DomainError("FORBIDDEN", "Current policy delivery authority is unavailable.", 403);
}
export async function claimPolicyEvent(user: string, org: string, entity: string): Promise<OutboxLease | null> {
  return withScope(user, org, entity, "approval_policies.activate", async client => {
    await authorize(client, org, entity);
    await client.query(`UPDATE outbox_events SET status='failed',lease_token=NULL,lease_until=NULL,completed_at=clock_timestamp(),last_error_code='ATTEMPTS_EXHAUSTED'
      WHERE organization_id=$1 AND legal_entity_id=$2 AND principal_id=$3 AND status='leased' AND lease_until<=clock_timestamp() AND attempts=3`, [org, entity, user]);
    const selected = await client.query(`SELECT id FROM outbox_events WHERE organization_id=$1 AND legal_entity_id=$2 AND principal_id=$3 AND attempts<3
      AND ((status='pending' AND available_at<=clock_timestamp()) OR (status='leased' AND lease_until<=clock_timestamp()))
      ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [org, entity, user]);
    if (!selected.rowCount) return null;
    const lease = { eventId: selected.rows[0].id as string, token: randomUUID() };
    await client.query("UPDATE outbox_events SET status='leased',attempts=attempts+1,lease_token=$2,lease_until=clock_timestamp()+interval '60 seconds' WHERE id=$1", [lease.eventId, lease.token]);
    return Lease.parse(lease);
  });
}
export async function deliverPolicyEvent(user: string, org: string, entity: string, input: OutboxLease): Promise<"delivered" | "cancelled" | "lease_lost"> {
  const lease = Lease.parse(input);
  return withScope(user, org, entity, "approval_policies.activate", async client => {
    await authorize(client, org, entity);
    const selected = await client.query(`SELECT * FROM outbox_events WHERE id=$1 AND organization_id=$2 AND legal_entity_id=$3 AND principal_id=$4
      AND status='leased' AND lease_token=$5 AND lease_until>clock_timestamp() FOR UPDATE`, [lease.eventId, org, entity, user, lease.token]);
    if (!selected.rowCount) return "lease_lost";
    const event = selected.rows[0];
    const source = await client.query("SELECT 1 FROM approval_policies WHERE organization_id=$1 AND legal_entity_id=$2 AND id=$3 AND status='active' AND version=$4 AND content_hash=$5", [org, entity, event.policy_id, event.source_version, event.source_hash]);
    const recipient = await client.query("SELECT app_security.policy_alert_recipient_eligible($1,$2,$3) AS allowed", [org, entity, event.recipient_id]);
    if (!source.rowCount || !recipient.rows[0].allowed) {
      await client.query("UPDATE outbox_events SET status='cancelled',lease_token=NULL,lease_until=NULL,completed_at=clock_timestamp(),last_error_code=$2 WHERE id=$1", [event.id, source.rowCount ? "RECIPIENT_UNAVAILABLE" : "SOURCE_CHANGED"]);
      return "cancelled";
    }
    // Effect and completion commit together. Repeated delivery is at least once;
    // the event/effect key prevents duplicate local alerts, not external sends.
    await client.query("SELECT app_security.emit_policy_alert($1,$2)", [event.id, lease.token]);
    await client.query("UPDATE outbox_events SET status='delivered',lease_token=NULL,lease_until=NULL,completed_at=clock_timestamp(),last_error_code=NULL WHERE id=$1", [event.id]);
    return "delivered";
  });
}
export async function deferPolicyEvent(user: string, org: string, entity: string, input: OutboxLease): Promise<boolean> {
  const lease = Lease.parse(input);
  return withScope(user, org, entity, "approval_policies.activate", async client => {
    await authorize(client, org, entity);
    const result = await client.query(`UPDATE outbox_events SET status=CASE WHEN attempts=3 THEN 'failed' ELSE 'pending' END,
      available_at=clock_timestamp()+attempts*interval '5 seconds',lease_token=NULL,lease_until=NULL,last_error_code='DELIVERY_FAILED',
      completed_at=CASE WHEN attempts=3 THEN clock_timestamp() ELSE NULL END
      WHERE id=$1 AND organization_id=$2 AND legal_entity_id=$3 AND principal_id=$4 AND status='leased' AND lease_token=$5 AND lease_until>clock_timestamp()`, [lease.eventId, org, entity, user, lease.token]);
    return result.rowCount === 1;
  });
}
export async function processPolicyBatch(user: string, org: string, entity: string, limit = 10) {
  z.number().int().min(1).max(25).parse(limit);
  const counts = { delivered: 0, cancelled: 0, leaseLost: 0, deferred: 0 };
  for (let count = 0; count < limit; count++) {
    const lease = await claimPolicyEvent(user, org, entity);
    if (!lease) break;
    try {
      const outcome = await deliverPolicyEvent(user, org, entity, lease);
      if (outcome === "lease_lost") counts.leaseLost++; else counts[outcome]++;
    } catch (error) {
      // Access revocation never becomes a background permission bypass.
      if (error instanceof DomainError && [403, 404].includes(error.status)) throw error;
      if (await deferPolicyEvent(user, org, entity, lease)) counts.deferred++; else counts.leaseLost++;
    }
  }
  return counts;
}
