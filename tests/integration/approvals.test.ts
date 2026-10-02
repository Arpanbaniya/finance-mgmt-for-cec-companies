import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, expect, it } from "vitest";
import { databasePool } from "@/db/client";
import { withScope } from "@/features/identity/scope";
import { ApprovalPolicyCreate } from "@/features/approvals/contracts";
import { createPolicy, getPolicy, listPolicies, activatePolicy, listAudit } from "@/features/approvals/service";
import { canonicalJSON, contentHash, type JsonValue } from "@/domain/approvals";
config({ path: ".env.local", quiet: true });
const org = randomUUID(), otherOrg = randomUUID(), entity = randomUUID(), secondEntity = randomUUID(), otherEntity = randomUUID();
const maker = `approval-${randomUUID()}`, checker = `approval-${randomUUID()}`, finance = `approval-${randomUUID()}`, reviewer = `approval-${randomUUID()}`, outsider = `approval-${randomUUID()}`;
const users = [maker, checker, finance, reviewer, outsider];
const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
function definition(from = "2026-01-01", to = "2027-01-01") { return ApprovalPolicyCreate.parse({ name: `Journal review ${randomUUID()}`, effectiveFrom: from, effectiveTo: to, aggregateTypes: ["journal"], currency: "NPR", makerChecker: true, thresholds: [{ minInclusive: "0.00", maxExclusive: "1000.00", requiredPermission: "journals.approve", numberOfDistinctApprovers: 1 }, { minInclusive: "1000.00", requiredPermission: "journals.approve", numberOfDistinctApprovers: 2 }] }); }
beforeAll(async () => {
  const url = new URL(process.env.MIGRATION_DATABASE_URL ?? ""); if (url.hostname !== "127.0.0.1" || url.pathname !== "/kaamledger") throw new Error("Approval fixtures require the dedicated local database.");
  for (const id of users) await admin.query("INSERT INTO auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Approval test',$2,true,now(),now())", [id, `${id}@example.invalid`]);
  await admin.query("INSERT INTO organizations(id,name) VALUES($1,'Approval A'),($2,'Approval B')", [org, otherOrg]);
  for (const [id, organization, creator] of [[entity, org, maker], [secondEntity, org, maker], [otherEntity, otherOrg, outsider]]) await admin.query("INSERT INTO legal_entities(id,organization_id,name,active_modes,reporting_profile,created_by) VALUES($1,$2,'Approval company','[\"labour\"]','demo_accrual',$3)", [id, organization, creator]);
  for (const [id, roles] of [[maker, ["organization_admin", "policy_reviewer"]], [checker, ["finance_manager", "policy_reviewer"]], [finance, ["finance_manager"]], [reviewer, ["policy_reviewer"]]] as const) await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,$4,$5,'[]')", [randomUUID(), org, id, JSON.stringify(roles), JSON.stringify([entity, secondEntity])]);
  await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,'[\"organization_admin\"]',$4,'[]')", [randomUUID(), otherOrg, outsider, JSON.stringify([otherEntity])]);
});
afterAll(async () => {
  const client = await admin.connect();
  try {
    await client.query("BEGIN"); await client.query("ALTER TABLE audit_events DISABLE TRIGGER audit_append_only"); await client.query("ALTER TABLE approval_policies DISABLE TRIGGER approval_policy_no_delete");
    for (const table of ["audit_events", "idempotency_results", "approval_policies", "memberships", "legal_entities"]) await client.query(`DELETE FROM ${table} WHERE organization_id=ANY($1::uuid[])`, [[org, otherOrg]]);
    await client.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [[org, otherOrg]]); await client.query("DELETE FROM auth_user WHERE id=ANY($1::text[])", [users]);
    await client.query("ALTER TABLE approval_policies ENABLE TRIGGER approval_policy_no_delete"); await client.query("ALTER TABLE audit_events ENABLE TRIGGER audit_append_only"); await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); await admin.end(); await databasePool().end(); }
});
it("concurrent draft creation returns one original response, even after activation", async () => {
  const input = definition(), key = randomUUID();
  const [a, b] = await Promise.all([createPolicy(maker, org, entity, input, key, randomUUID()), createPolicy(maker, org, entity, input, key, randomUUID())]);
  expect(a).toEqual(b); expect(a.contentHash).toBe(contentHash(input as JsonValue));
  expect((await admin.query("SELECT * FROM audit_events WHERE target_id=$1", [a.id])).rowCount).toBe(1);
  await activatePolicy(checker, org, entity, a.id, { reason: "Independent review" }, 1, randomUUID(), randomUUID());
  expect(await createPolicy(maker, org, entity, input, key, randomUUID())).toEqual(a);
  await expect(createPolicy(maker, org, entity, { ...input, name: "Changed" }, key, randomUUID())).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});
it("activation needs a different designated admin/finance reviewer", async () => {
  const draft = await createPolicy(maker, org, entity, definition("2027-01-01", "2028-01-01"), randomUUID(), randomUUID());
  await expect(activatePolicy(maker, org, entity, draft.id, {}, 1, randomUUID(), randomUUID())).rejects.toMatchObject({ code: "SELF_APPROVAL", status: 403 });
  for (const actor of [finance, reviewer]) await expect(activatePolicy(actor, org, entity, draft.id, {}, 1, randomUUID(), randomUUID())).rejects.toMatchObject({ status: 403 });
  expect((await getPolicy(maker, org, entity, draft.id)).status).toBe("draft");
  expect((await admin.query("SELECT * FROM audit_events WHERE target_id=$1", [draft.id])).rowCount).toBe(1);
  const key = randomUUID(), requestId = randomUUID();
  const [a, b] = await Promise.all([activatePolicy(checker, org, entity, draft.id, {}, 1, key, requestId), activatePolicy(checker, org, entity, draft.id, {}, 1, key, randomUUID())]);
  expect(a).toEqual(b); expect(a.requestId).toBe(requestId); expect(a.version).toBe(2);
  await expect(activatePolicy(checker, org, entity, draft.id, {}, 1, randomUUID(), randomUUID())).rejects.toMatchObject({ status: 412 });
  await expect(activatePolicy(checker, org, entity, draft.id, { reason: "Different request" }, 1, key, randomUUID())).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect((await admin.query("SELECT * FROM audit_events WHERE target_id=$1", [draft.id])).rowCount).toBe(2);
});
it("racing overlapping activations commit one winner, no losing audit or replay", async () => {
  const [a, b] = await Promise.all([createPolicy(maker, org, entity, definition("2028-01-01", "2029-01-01"), randomUUID(), randomUUID()), createPolicy(maker, org, entity, definition("2028-06-01", "2029-02-01"), randomUUID(), randomUUID())]);
  const results = await Promise.allSettled([a, b].map(d => activatePolicy(checker, org, entity, d.id, {}, 1, randomUUID(), randomUUID())));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "POLICY_OVERLAP" } });
  const rows = await admin.query("SELECT status FROM approval_policies WHERE id=ANY($1::uuid[])", [[a.id, b.id]]); expect(rows.rows.map(r => r.status).sort()).toEqual(["active", "draft"]);
  expect((await admin.query("SELECT * FROM audit_events WHERE target_id=ANY($1::uuid[]) AND action='approval_policy.activate'", [[a.id, b.id]])).rowCount).toBe(1);
});
it("policy IDs and cursor lists stay scoped across entity and organization guesses", async () => {
  const input = definition(), key = randomUUID(); const a = await createPolicy(maker, org, entity, input, key, randomUUID()), b = await createPolicy(maker, org, secondEntity, input, key, randomUUID());
  expect(a.id).not.toBe(b.id); await expect(getPolicy(maker, org, secondEntity, a.id)).rejects.toMatchObject({ status: 404 }); await expect(getPolicy(maker, otherOrg, otherEntity, a.id)).rejects.toMatchObject({ status: 404 });
  const first = await listPolicies(maker, org, entity, 1); expect(first.data).toHaveLength(1); expect(first.nextCursor).not.toBeNull();
  const next = await listPolicies(maker, org, entity, 1, first.nextCursor!); expect(next.data[0].id).not.toBe(first.data[0].id);
  expect((await databasePool().query("SELECT * FROM approval_policies")).rows).toHaveLength(0);
  expect(await withScope(maker, org, entity, "entity.read", async c => (await c.query("SELECT * FROM approval_policies WHERE id=$1", [b.id])).rows)).toEqual([]);
});
it("direct SQL cannot self-activate, forge content, mutate an active definition or delete", async () => {
  const draft = await createPolicy(maker, org, secondEntity, definition(), randomUUID(), randomUUID());
  for (const actor of [maker, finance, reviewer]) expect(await withScope(actor, org, secondEntity, "entity.read", async c => (await c.query("UPDATE approval_policies SET status='active',version=2,activated_by=$2,activated_at=now() WHERE id=$1", [draft.id, actor])).rowCount)).toBe(0);
  await expect(withScope(checker, org, secondEntity, "entity.read", c => c.query("UPDATE approval_policies SET definition=jsonb_set(definition,'{name}','\"Tampered\"') WHERE id=$1", [draft.id]))).rejects.toMatchObject({ code: "P0001" });
  await activatePolicy(checker, org, secondEntity, draft.id, {}, 1, randomUUID(), randomUUID());
  await expect(withScope(checker, org, secondEntity, "entity.read", c => c.query("UPDATE approval_policies SET activation_reason='Changed review' WHERE id=$1", [draft.id]))).rejects.toMatchObject({ code: "P0001" });
  await expect(databasePool().query("DELETE FROM approval_policies")).rejects.toMatchObject({ code: "42501" });
  const bad = { ...definition(), thresholds: [{ minInclusive: "1.00", requiredPermission: "journals.approve", numberOfDistinctApprovers: 1 }] };
  await expect(withScope(maker, org, entity, "entity.read", c => c.query("INSERT INTO approval_policies(id,organization_id,legal_entity_id,definition,canonical_payload,content_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)", [randomUUID(), org, entity, JSON.stringify(bad), canonicalJSON(bad), contentHash(bad), maker]))).rejects.toMatchObject({ code: "P0001" });
});
it("metadata audit filters legacy entity events without leaking membership or other entities", async () => {
  const legacy = randomUUID(), hidden = randomUUID();
  await admin.query("INSERT INTO audit_events(id,organization_id,actor_id,action,target_id,request_id,occurred_at) VALUES($1,$2,$3,'entity.create',$4,'legacy','2025-01-01T00:00:00Z'),($5,$2,$3,'membership.update',$6,'hidden','2025-01-01T00:00:00Z')", [legacy, org, maker, entity, hidden, randomUUID()]);
  const data = await listAudit(maker, org, entity, { limit: 100 }); expect(data.data.some(e => e.id === legacy)).toBe(true); expect(data.data.some(e => e.id === hidden)).toBe(false); expect(data.data.every(e => e.entityId === entity)).toBe(true);
  expect((await listAudit(maker, org, entity, { limit: 100, fromInstant: "2025-01-01T00:00:00Z", toInstantExclusive: "2025-01-01T00:00:01Z", action: "entity.create" })).data.map(e => e.id)).toEqual([legacy]);
  expect((await listAudit(maker, org, entity, { limit: 100, toInstantExclusive: "2025-01-01T00:00:00Z" })).data).toEqual([]);
  const direct = await withScope(maker, org, entity, "entity.read", async c => (await c.query("SELECT * FROM audit_events WHERE id=$1", [hidden])).rows); expect(direct).toEqual([]);
  await expect(listAudit(reviewer, org, entity, { limit: 25 })).rejects.toMatchObject({ status: 403 });
});
it("membership revocation still rejects authorized replay and leaves durable history", async () => {
  const draft = await createPolicy(maker, org, entity, definition("2030-01-01", "2031-01-01"), randomUUID(), randomUUID()), key = randomUUID();
  await activatePolicy(checker, org, entity, draft.id, {}, 1, key, randomUUID());
  await admin.query("UPDATE memberships SET roles='[\"finance_manager\"]',version=version+1 WHERE organization_id=$1 AND user_id=$2", [org, checker]);
  await expect(activatePolicy(checker, org, entity, draft.id, {}, 1, key, randomUUID())).rejects.toMatchObject({ status: 403 });
  expect((await getPolicy(maker, org, entity, draft.id)).status).toBe("active");
});
