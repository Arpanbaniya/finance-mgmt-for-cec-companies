import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, expect, it } from "vitest";
import { databasePool } from "@/db/client";
import { withScope } from "@/features/identity/scope";
import { createPolicy, activatePolicy, getPolicy } from "@/features/approvals/service";
import { listAlerts, acknowledgeAlert } from "@/features/alerts/service";
import { claimPolicyEvent, deliverPolicyEvent, deferPolicyEvent, processPolicyBatch } from "@/features/jobs/outbox";
import { getJob, retryJob } from "@/features/jobs/service";
config({ path: ".env.local", quiet: true });
const org = randomUUID(), otherOrg = randomUUID(), entity = randomUUID(), otherEntity = randomUUID(), secondEntity = randomUUID();
const maker = `outbox-${randomUUID()}`, checker = `outbox-${randomUUID()}`, ordinary = `outbox-${randomUUID()}`, outsider = `outbox-${randomUUID()}`;
const users = [maker, checker, ordinary, outsider], admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
let year = 2020;
async function draft() {
  const from = `${year++}-01-01`, to = `${year}-01-01`;
  return createPolicy(maker, org, entity, { name: `Delivery ${randomUUID()}`, effectiveFrom: from, effectiveTo: to, aggregateTypes: ["journal"], currency: "NPR", makerChecker: true,
    thresholds: [{ minInclusive: "0.00", requiredPermission: "journals.approve", numberOfDistinctApprovers: 1 }] }, randomUUID(), randomUUID());
}
async function activated() { const policy = await draft(); await activatePolicy(checker, org, entity, policy.id, {}, 1, randomUUID(), randomUUID()); return policy; }
async function eventFor(policy: string) { return (await admin.query("SELECT * FROM outbox_events WHERE policy_id=$1", [policy])).rows[0]; }
// Simulate elapsed time/crash in this run's generated rows, not a database reset.
async function advanceEvent(id: string, column: "lease_until" | "available_at") {
  const client = await admin.connect();
  try { await client.query("BEGIN"); await client.query("ALTER TABLE outbox_events DISABLE TRIGGER outbox_guard");
    await client.query(`UPDATE outbox_events SET ${column}=clock_timestamp()-interval '1 second' WHERE id=$1 AND organization_id=$2`, [id, org]);
    await client.query("ALTER TABLE outbox_events ENABLE TRIGGER outbox_guard"); await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
beforeAll(async () => {
  const url = new URL(process.env.MIGRATION_DATABASE_URL ?? ""); if (url.hostname !== "127.0.0.1" || url.pathname !== "/kaamledger") throw new Error("Outbox fixtures require the dedicated local database.");
  for (const id of users) await admin.query("INSERT INTO auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Outbox test',$2,true,now(),now())", [id, `${id}@example.invalid`]);
  await admin.query("INSERT INTO organizations(id,name) VALUES($1,'Outbox A'),($2,'Outbox B')", [org, otherOrg]);
  for (const [id, organization, creator] of [[entity, org, maker], [secondEntity, org, maker], [otherEntity, otherOrg, outsider]]) await admin.query("INSERT INTO legal_entities(id,organization_id,name,active_modes,reporting_profile,created_by) VALUES($1,$2,'Delivery company','[\"labour\"]','demo_accrual',$3)", [id, organization, creator]);
  for (const [id, roles] of [[maker, ["organization_admin"]], [checker, ["organization_admin", "policy_reviewer"]], [ordinary, ["finance_manager"]]] as const) await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,$4,$5,'[]')", [randomUUID(), org, id, JSON.stringify(roles), JSON.stringify([entity, secondEntity])]);
  await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,'[\"organization_admin\"]',$4,'[]')", [randomUUID(), otherOrg, outsider, JSON.stringify([otherEntity])]);
});
afterAll(async () => {
  const client = await admin.connect();
  try { await client.query("BEGIN"); await client.query("ALTER TABLE audit_events DISABLE TRIGGER audit_append_only"); await client.query("ALTER TABLE approval_policies DISABLE TRIGGER approval_policy_no_delete");
    await client.query("ALTER TABLE job_retries DISABLE TRIGGER job_retry_append_only");
    for (const table of ["job_retries", "alerts", "outbox_events", "audit_events", "idempotency_results", "approval_policies", "memberships", "legal_entities"]) await client.query(`DELETE FROM ${table} WHERE organization_id=ANY($1::uuid[])`, [[org, otherOrg]]);
    await client.query("ALTER TABLE job_retries ENABLE TRIGGER job_retry_append_only");
    await client.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [[org, otherOrg]]); await client.query("DELETE FROM auth_user WHERE id=ANY($1::text[])", [users]);
    await client.query("ALTER TABLE approval_policies ENABLE TRIGGER approval_policy_no_delete"); await client.query("ALTER TABLE audit_events ENABLE TRIGGER audit_append_only"); await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); await admin.end(); await databasePool().end(); }
});
it("lost activation response replays one event; racing consumers produce one local effect", async () => {
  const policy = await draft(), key = randomUUID(), firstRequest = randomUUID();
  const command = await activatePolicy(checker, org, entity, policy.id, {}, 1, key, firstRequest);
  expect(await activatePolicy(checker, org, entity, policy.id, {}, 1, key, randomUUID())).toEqual(command);
  expect((await admin.query("SELECT * FROM outbox_events WHERE policy_id=$1", [policy.id])).rowCount).toBe(1);
  const leases = await Promise.all([claimPolicyEvent(checker, org, entity), claimPolicyEvent(checker, org, entity)]);
  expect(leases.filter(Boolean)).toHaveLength(1); const lease = leases.find(Boolean)!;
  const outcomes = await Promise.all([deliverPolicyEvent(checker, org, entity, lease), deliverPolicyEvent(checker, org, entity, lease)]);
  expect(outcomes.sort()).toEqual(["delivered", "lease_lost"]);
  expect((await admin.query("SELECT * FROM alerts WHERE event_id=$1", [lease.eventId])).rowCount).toBe(1);
  expect((await eventFor(policy.id)).status).toBe("delivered");
  expect((await listAlerts(maker, org, entity, 25)).data.map(a => a.policyId)).toContain(policy.id);
  expect((await listAlerts(checker, org, entity, 25)).data).toEqual([]);
});
it("expired crash lease is reclaimed, and the old token cannot complete or defer", async () => {
  const policy = await activated(), old = (await claimPolicyEvent(checker, org, entity))!;
  await advanceEvent(old.eventId, "lease_until"); const lease = (await claimPolicyEvent(checker, org, entity))!;
  expect(lease.eventId).toBe(old.eventId); expect(lease.token).not.toBe(old.token);
  expect(await deliverPolicyEvent(checker, org, entity, old)).toBe("lease_lost"); expect(await deferPolicyEvent(checker, org, entity, old)).toBe(false);
  expect(await deliverPolicyEvent(checker, org, entity, lease)).toBe("delivered"); expect((await eventFor(policy.id)).attempts).toBe(2);
});
it("delivery error retries are bounded and retain redacted status", async () => {
  const policy = await activated();
  for (let n = 1; n <= 3; n++) {
    const lease = (await claimPolicyEvent(checker, org, entity))!; expect(await deferPolicyEvent(checker, org, entity, lease)).toBe(true);
    const event = await eventFor(policy.id); expect(event.attempts).toBe(n); expect(event.last_error_code).toBe("DELIVERY_FAILED");
    if (n < 3) { expect(await claimPolicyEvent(checker, org, entity)).toBeNull(); await advanceEvent(event.id, "available_at"); }
  }
  expect((await eventFor(policy.id)).status).toBe("failed"); expect(await claimPolicyEvent(checker, org, entity)).toBeNull();
});
it("three worker crashes exhaust leases without creating an alert", async () => {
  const policy = await activated();
  for (let n = 1; n <= 3; n++) { const lease = (await claimPolicyEvent(checker, org, entity))!; await advanceEvent(lease.eventId, "lease_until"); }
  expect(await claimPolicyEvent(checker, org, entity)).toBeNull(); const event = await eventFor(policy.id);
  expect(event).toMatchObject({ status: "failed", attempts: 3, last_error_code: "ATTEMPTS_EXHAUSTED" }); expect((await admin.query("SELECT * FROM alerts WHERE event_id=$1", [event.id])).rowCount).toBe(0);
});
it("recipient revocation cancels delivery; reviewer revocation blocks execution and replay", async () => {
  const policy = await activated(), lease = (await claimPolicyEvent(checker, org, entity))!;
  try {
    await admin.query("UPDATE memberships SET roles='[\"owner\"]',version=version+1 WHERE organization_id=$1 AND user_id=$2", [org, maker]);
    expect(await deliverPolicyEvent(checker, org, entity, lease)).toBe("cancelled"); expect((await eventFor(policy.id)).last_error_code).toBe("RECIPIENT_UNAVAILABLE");
  } finally { await admin.query("UPDATE memberships SET roles='[\"organization_admin\"]',version=version+1 WHERE organization_id=$1 AND user_id=$2", [org, maker]); }
  const next = await activated(), pending = (await claimPolicyEvent(checker, org, entity))!;
  try {
    await admin.query("UPDATE memberships SET roles='[\"organization_admin\"]',version=version+1 WHERE organization_id=$1 AND user_id=$2", [org, checker]);
    await expect(deliverPolicyEvent(checker, org, entity, pending)).rejects.toMatchObject({ status: 403 });
    expect((await eventFor(next.id)).status).toBe("leased"); expect((await admin.query("SELECT * FROM alerts WHERE event_id=$1", [pending.eventId])).rowCount).toBe(0);
  } finally { await admin.query("UPDATE memberships SET roles='[\"organization_admin\",\"policy_reviewer\"]',version=version+1 WHERE organization_id=$1 AND user_id=$2", [org, checker]); }
  expect(await deliverPolicyEvent(checker, org, entity, pending)).toBe("delivered");
});
it("unscoped runtime SQL, guessed entities, ordinary finance and fabricated effects are denied", async () => {
  expect((await databasePool().query("SELECT * FROM outbox_events")).rows).toEqual([]); expect((await databasePool().query("SELECT * FROM alerts")).rows).toEqual([]);
  await expect(claimPolicyEvent(ordinary, org, entity)).rejects.toMatchObject({ status: 403 }); await expect(claimPolicyEvent(checker, otherOrg, otherEntity)).rejects.toMatchObject({ status: 404 });
  expect(await claimPolicyEvent(checker, org, secondEntity)).toBeNull();
  for (const table of ["outbox_events", "alerts"]) await expect(databasePool().query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: "42501" });
  const event = (await admin.query("SELECT * FROM outbox_events WHERE organization_id=$1 AND status='delivered' LIMIT 1", [org])).rows[0];
  await expect(withScope(checker, org, entity, "entity.read", c => c.query("UPDATE outbox_events SET source_hash=repeat('0',64) WHERE id=$1", [event.id]))).rejects.toMatchObject({ code: "P0001" });
  await expect(withScope(checker, org, entity, "entity.read", c => c.query("INSERT INTO alerts(id,organization_id,legal_entity_id,event_id,effect_key,recipient_id,policy_id) VALUES($1,$2,$3,$4,'policy_activation_alert',$5,$6)", [randomUUID(), org, entity, event.id, outsider, event.policy_id]))).rejects.toMatchObject({ code: "42501" });
  await expect(withScope(checker, org, secondEntity, "entity.read", c => c.query("SELECT app_security.emit_policy_alert($1,$2)", [event.id, randomUUID()]))).rejects.toMatchObject({ code: "P0001" });
});
it("recipient acknowledgement is version-bound, durable and private on replay", async () => {
  const page = await listAlerts(maker, org, entity, 1); expect(page.nextCursor).not.toBeNull();
  const alert = page.data[0], key = randomUUID(), reason = { reason: "Reviewed activation notification" };
  const [a, b] = await Promise.all([acknowledgeAlert(maker, org, entity, alert.id, reason, 1, key, randomUUID()), acknowledgeAlert(maker, org, entity, alert.id, reason, 1, key, randomUUID())]);
  expect(a).toEqual(b); expect(a.status).toBe("acknowledged"); expect(a.version).toBe(2);
  await expect(acknowledgeAlert(maker, org, entity, alert.id, { reason: "Different" }, 1, key, randomUUID())).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await expect(acknowledgeAlert(maker, org, entity, alert.id, reason, 1, randomUUID(), randomUUID())).rejects.toMatchObject({ status: 412 });
  await expect(acknowledgeAlert(checker, org, entity, alert.id, reason, 1, key, randomUUID())).rejects.toMatchObject({ status: 404 });
  await expect(acknowledgeAlert(maker, org, secondEntity, alert.id, reason, 1, key, randomUUID())).rejects.toMatchObject({ status: 404 });
  expect((await admin.query("SELECT * FROM audit_events WHERE target_id=$1 AND action='alert.acknowledge'", [alert.id])).rowCount).toBe(1);
  const next = await listAlerts(maker, org, entity, 1, page.nextCursor!); expect(next.data[0].id).not.toBe(alert.id);
  try {
    await admin.query("UPDATE memberships SET roles='[\"owner\"]',version=version+1 WHERE organization_id=$1 AND user_id=$2", [org, maker]);
    await expect(acknowledgeAlert(maker, org, entity, alert.id, reason, 1, key, randomUUID())).rejects.toMatchObject({ status: 403 });
  } finally { await admin.query("UPDATE memberships SET roles='[\"organization_admin\"]',version=version+1 WHERE organization_id=$1 AND user_id=$2", [org, maker]); }
});
it("bounded scoped batches deliver committed effects and reject unbounded work", async () => {
  const policy = await activated(); expect(await processPolicyBatch(checker, org, entity, 1)).toEqual({ delivered: 1, cancelled: 0, leaseLost: 0, deferred: 0 }); expect((await eventFor(policy.id)).status).toBe("delivered");
  await expect(processPolicyBatch(checker, org, entity, 26)).rejects.toThrow();
});
it("duplicate event-effect consumption deduplicates without exposing recipient rows to the reviewer", async () => {
  const policy = await activated(), lease = (await claimPolicyEvent(checker, org, entity))!;
  await withScope(checker, org, entity, "approval_policies.activate", async client => {
    await client.query("SELECT app_security.emit_policy_alert($1,$2)", [lease.eventId, lease.token]);
    await client.query("SELECT app_security.emit_policy_alert($1,$2)", [lease.eventId, lease.token]);
    expect((await client.query("SELECT * FROM alerts WHERE event_id=$1", [lease.eventId])).rows).toEqual([]);
  });
  expect(await deliverPolicyEvent(checker, org, entity, lease)).toBe("delivered");
  expect((await admin.query("SELECT * FROM alerts WHERE event_id=$1", [lease.eventId])).rowCount).toBe(1);
  expect((await eventFor(policy.id)).status).toBe("delivered");
});
it("effect and completion roll back together if the worker crashes before commit", async () => {
  const policy = await activated(), lease = (await claimPolicyEvent(checker, org, entity))!;
  await admin.query(`CREATE FUNCTION app_security.outbox_completion_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${lease.eventId}'::uuid AND NEW.status='delivered' THEN RAISE EXCEPTION 'Injected worker crash'; END IF; RETURN NEW; END $$`);
  await admin.query("CREATE TRIGGER outbox_completion_fault BEFORE UPDATE ON outbox_events FOR EACH ROW EXECUTE FUNCTION app_security.outbox_completion_fault()");
  try {
    await expect(deliverPolicyEvent(checker, org, entity, lease)).rejects.toMatchObject({ code: "P0001" });
    expect((await admin.query("SELECT * FROM alerts WHERE event_id=$1", [lease.eventId])).rowCount).toBe(0); expect((await eventFor(policy.id)).status).toBe("leased");
  } finally { await admin.query("DROP TRIGGER outbox_completion_fault ON outbox_events"); await admin.query("DROP FUNCTION app_security.outbox_completion_fault()"); }
  expect(await deliverPolicyEvent(checker, org, entity, lease)).toBe("delivered");
});
it.each(["40001", "40P01"])("real aborted PostgreSQL %s retries rollback all writes and restore scoped authorization", async code => {
  const auditId = randomUUID(); let calls = 0;
  const value = await withScope(maker, org, entity, "entity.read", async client => {
    calls++; await client.query("INSERT INTO audit_events(id,organization_id,legal_entity_id,actor_id,action,target_id,request_id) VALUES($1,$2,$3,$4,'entity.update',$3,'retry-fixture')", [auditId, org, entity, maker]);
    if (calls === 1) await client.query(`DO $$ BEGIN RAISE EXCEPTION 'Injected transaction abort' USING ERRCODE='${code}'; END $$`);
    return (await client.query("SELECT current_setting('app.user_id') AS actor")).rows[0].actor;
  });
  expect(value).toBe(maker); expect(calls).toBe(2); expect((await admin.query("SELECT * FROM audit_events WHERE id=$1", [auditId])).rowCount).toBe(1);
});
it("transaction retry rechecks a changed permission before replaying the command", async () => {
  let calls = 0;
  try {
    await expect(withScope(maker, org, entity, "entity.create", async client => {
      calls++; await admin.query("UPDATE memberships SET roles='[\"owner\"]',version=version+1 WHERE organization_id=$1 AND user_id=$2", [org, maker]);
      await client.query("DO $$ BEGIN RAISE EXCEPTION 'Injected serialization abort' USING ERRCODE='40001'; END $$");
    })).rejects.toMatchObject({ status: 403 }); expect(calls).toBe(1);
  } finally { await admin.query("UPDATE memberships SET roles='[\"organization_admin\"]',version=version+1 WHERE organization_id=$1 AND user_id=$2", [org, maker]); }
});
it("failed outbox insertion rolls back activation, audit and idempotency together", async () => {
  const policy = await draft(), key = randomUUID();
  await admin.query(`CREATE FUNCTION app_security.outbox_acceptance_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.policy_id='${policy.id}'::uuid THEN RAISE EXCEPTION 'Injected delivery enqueue failure'; END IF; RETURN NEW; END $$`);
  await admin.query("CREATE TRIGGER outbox_acceptance_fault BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION app_security.outbox_acceptance_fault()");
  try {
    await expect(activatePolicy(checker, org, entity, policy.id, {}, 1, key, randomUUID())).rejects.toMatchObject({ code: "P0001" });
    expect((await getPolicy(maker, org, entity, policy.id)).status).toBe("draft"); expect(await eventFor(policy.id)).toBeUndefined();
    expect((await admin.query("SELECT * FROM audit_events WHERE target_id=$1 AND action='approval_policy.activate'", [policy.id])).rowCount).toBe(0);
    expect((await admin.query("SELECT * FROM idempotency_results WHERE organization_id=$1 AND key=$2", [org, key])).rowCount).toBe(0);
  } finally { await admin.query("DROP TRIGGER outbox_acceptance_fault ON outbox_events"); await admin.query("DROP FUNCTION app_security.outbox_acceptance_fault()"); }
  await activatePolicy(checker, org, entity, policy.id, {}, 1, key, randomUUID());
  expect(await processPolicyBatch(checker, org, entity, 1)).toMatchObject({ delivered: 1 });
});

async function failCycle(id: string) {
  for (let n = 0; n < 3; n++) {
    const lease = (await claimPolicyEvent(checker, org, entity))!;
    expect(lease.eventId).toBe(id); expect(await deferPolicyEvent(checker, org, entity, lease)).toBe(true);
    if (n < 2) await advanceEvent(id, "available_at");
  }
}
it("job inspection is typed, private, versioned and does not run delivery", async () => {
  const policy = await activated(), event = await eventFor(policy.id);
  const job = await getJob(checker, org, entity, event.id);
  expect(job).toMatchObject({ status: "pending", version: 1, totalAttempts: 0, retryCount: 0, sourceId: policy.id, inputHash: policy.contentHash, totalItems: 1, completedItems: 0, retryHistory: [] });
  expect(job).not.toHaveProperty("leaseToken"); expect(job).not.toHaveProperty("recipientId");
  expect((await getPolicy(checker, org, entity, policy.id)).deliveryJobId).toBe(event.id);
  expect((await getPolicy(maker, org, entity, policy.id)).deliveryJobId).toBeNull();
  for (const actor of [maker, ordinary]) await expect(getJob(actor, org, entity, event.id)).rejects.toMatchObject({ status: 403 });
  try {
    await admin.query("UPDATE memberships SET roles='[\"finance_manager\",\"policy_reviewer\"]',version=version+1 WHERE organization_id=$1 AND user_id=$2", [org, ordinary]);
    await expect(getJob(ordinary, org, entity, event.id)).rejects.toMatchObject({ status: 404 });
    await expect(retryJob(ordinary, org, entity, event.id, { reason: "Another reviewer" }, 1, randomUUID(), randomUUID())).rejects.toMatchObject({ status: 404 });
  } finally { await admin.query("UPDATE memberships SET roles='[\"finance_manager\"]',version=version+1 WHERE organization_id=$1 AND user_id=$2", [org, ordinary]); }
  await expect(getJob(checker, org, secondEntity, event.id)).rejects.toMatchObject({ status: 404 });
  await expect(getJob(checker, otherOrg, otherEntity, event.id)).rejects.toMatchObject({ status: 404 });
  await expect(retryJob(checker, org, entity, event.id, { reason: "Investigated" }, 1, randomUUID(), randomUUID())).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  const lease = (await claimPolicyEvent(checker, org, entity))!;
  expect(await getJob(checker, org, entity, event.id)).toMatchObject({ status: "leased", version: 2, totalAttempts: 1 });
  await deliverPolicyEvent(checker, org, entity, lease);
  expect(await getJob(checker, org, entity, event.id)).toMatchObject({ status: "delivered", version: 3, completedItems: 1 });
  await expect(retryJob(checker, org, entity, event.id, { reason: "Investigated" }, 3, randomUUID(), randomUUID())).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
});
it("racing recovery commits one receipt/audit, preserves lifetime attempts and replays the original result after delivery", async () => {
  const policy = await activated(), event = await eventFor(policy.id); await failCycle(event.id);
  const failed = await getJob(checker, org, entity, event.id), key = randomUUID(), reason = { reason: "Investigated transient delivery failure" };
  expect(failed).toMatchObject({ status: "failed", version: 7, totalAttempts: 3, attempts: 3 });
  await expect(withScope(checker, org, entity, "jobs.update", c => c.query("UPDATE outbox_events SET status='pending',attempts=0,retry_count=retry_count+1,available_at=clock_timestamp(),completed_at=NULL,last_error_code=NULL WHERE id=$1", [event.id]))).rejects.toMatchObject({ code: "P0001" });
  await expect(withScope(checker, org, entity, "jobs.update", c => c.query("UPDATE outbox_events SET total_attempts=0 WHERE id=$1", [event.id]))).rejects.toMatchObject({ code: "P0001" });
  await expect(retryJob(checker, org, entity, event.id, reason, 6, randomUUID(), randomUUID())).rejects.toMatchObject({ status: 412 });
  const responses = await Promise.all([retryJob(checker, org, entity, event.id, reason, failed.version, key, randomUUID()), retryJob(checker, org, entity, event.id, reason, failed.version, key, randomUUID())]);
  expect(responses[0]).toEqual(responses[1]);
  expect(await getJob(checker, org, entity, event.id)).toMatchObject({ status: "pending", version: 8, totalAttempts: 3, attempts: 0, retryCount: 1, retryHistory: [{ fromVersion: 7, reason: reason.reason }] });
  expect((await admin.query("SELECT * FROM audit_events WHERE target_id=$1 AND action='job.retry'", [event.id])).rowCount).toBe(1);
  await expect(retryJob(checker, org, entity, event.id, { reason: "Changed reason" }, failed.version, key, randomUUID())).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  const lease = (await claimPolicyEvent(checker, org, entity))!; await deliverPolicyEvent(checker, org, entity, lease);
  expect(await retryJob(checker, org, entity, event.id, reason, failed.version, key, randomUUID())).toEqual(responses[0]);
  expect(await getJob(checker, org, entity, event.id)).toMatchObject({ status: "delivered", totalAttempts: 4, retryCount: 1 });
  expect((await admin.query("SELECT * FROM alerts WHERE event_id=$1", [event.id])).rowCount).toBe(1);
  try {
    await admin.query("UPDATE memberships SET roles='[\"policy_reviewer\"]',version=version+1 WHERE organization_id=$1 AND user_id=$2", [org, checker]);
    await expect(getJob(checker, org, entity, event.id)).rejects.toMatchObject({ status: 403 });
    await expect(retryJob(checker, org, entity, event.id, reason, failed.version, key, randomUUID())).rejects.toMatchObject({ status: 403 });
  } finally { await admin.query("UPDATE memberships SET roles='[\"organization_admin\",\"policy_reviewer\"]',version=version+1 WHERE organization_id=$1 AND user_id=$2", [org, checker]); }
});
it("manual retry is bounded to three cycles without erasing attempts or immutable receipts", async () => {
  const policy = await activated(), event = await eventFor(policy.id); await failCycle(event.id);
  for (let count = 1; count <= 3; count++) {
    const failed = await getJob(checker, org, entity, event.id);
    await retryJob(checker, org, entity, event.id, { reason: `Recovery cycle ${count}` }, failed.version, randomUUID(), randomUUID());
    await failCycle(event.id);
  }
  const failed = await getJob(checker, org, entity, event.id);
  expect(failed).toMatchObject({ status: "failed", totalAttempts: 12, attempts: 3, retryCount: 3 }); expect(failed.retryHistory).toHaveLength(3);
  await expect(retryJob(checker, org, entity, event.id, { reason: "One more" }, failed.version, randomUUID(), randomUUID())).rejects.toMatchObject({ code: "RETRY_LIMIT" });
  expect((await databasePool().query("SELECT * FROM job_retries")).rows).toEqual([]);
  for (const verb of ["DELETE FROM", "UPDATE"]) await expect(databasePool().query(verb === "UPDATE" ? "UPDATE job_retries SET reason='Changed'" : "DELETE FROM job_retries")).rejects.toMatchObject({ code: "42501" });
  await expect(admin.query("UPDATE job_retries SET reason='Changed' WHERE event_id=$1", [event.id])).rejects.toMatchObject({ code: "P0001" });
  await expect(withScope(checker, org, entity, "jobs.update", c => c.query("UPDATE outbox_events SET status='pending',attempts=0,retry_count=retry_count+1,completed_at=NULL WHERE id=$1", [event.id]))).rejects.toMatchObject({ code: "P0001" });
});
it("recipient grant revocation blocks recovery before creating history or idempotency", async () => {
  const policy = await activated(), event = await eventFor(policy.id); await failCycle(event.id);
  const job = await getJob(checker, org, entity, event.id), key = randomUUID();
  try {
    await admin.query("UPDATE memberships SET allowed_entity_ids='[]',version=version+1 WHERE organization_id=$1 AND user_id=$2", [org, maker]);
    await expect(retryJob(checker, org, entity, event.id, { reason: "Investigated failure" }, job.version, key, randomUUID())).rejects.toMatchObject({ code: "JOB_SOURCE_UNAVAILABLE" });
    expect((await admin.query("SELECT * FROM job_retries WHERE event_id=$1", [event.id])).rowCount).toBe(0);
    expect((await admin.query("SELECT * FROM idempotency_results WHERE organization_id=$1 AND key=$2", [org, key])).rowCount).toBe(0);
  } finally { await admin.query("UPDATE memberships SET allowed_entity_ids=$3,version=version+1 WHERE organization_id=$1 AND user_id=$2", [org, maker, JSON.stringify([entity, secondEntity])]); }
});
it("retry failure rolls back receipt, state, audit and replay result atomically", async () => {
  const policy = await activated(), event = await eventFor(policy.id); await failCycle(event.id);
  const failed = await getJob(checker, org, entity, event.id), key = randomUUID();
  await admin.query(`CREATE FUNCTION app_security.job_recovery_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${event.id}'::uuid AND NEW.status='pending' THEN RAISE EXCEPTION 'Injected retry failure'; END IF; RETURN NEW; END $$`);
  await admin.query("CREATE TRIGGER job_recovery_fault BEFORE UPDATE ON outbox_events FOR EACH ROW EXECUTE FUNCTION app_security.job_recovery_fault()");
  try {
    await expect(retryJob(checker, org, entity, event.id, { reason: "Investigated failure" }, failed.version, key, randomUUID())).rejects.toMatchObject({ code: "P0001" });
    expect(await getJob(checker, org, entity, event.id)).toEqual(failed);
    expect((await admin.query("SELECT * FROM job_retries WHERE event_id=$1", [event.id])).rowCount).toBe(0);
    expect((await admin.query("SELECT * FROM audit_events WHERE target_id=$1 AND action='job.retry'", [event.id])).rowCount).toBe(0);
    expect((await admin.query("SELECT * FROM idempotency_results WHERE organization_id=$1 AND key=$2", [org, key])).rowCount).toBe(0);
  } finally { await admin.query("DROP TRIGGER job_recovery_fault ON outbox_events"); await admin.query("DROP FUNCTION app_security.job_recovery_fault()"); }
});
