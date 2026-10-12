import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, expect, it } from "vitest";
import { databasePool } from "@/db/client";
import { withScope } from "@/features/identity/scope";
import { createParty, getParty, listParties, patchParty, archiveParty } from "@/features/parties/service";
import { listAudit } from "@/features/approvals/service";
config({ path: ".env.local", quiet: true });
const org = randomUUID(), foreignOrg = randomUUID(), entity = randomUUID(), other = randomUUID(), foreignEntity = randomUUID();
const finance = `party-${randomUUID()}`, auditor = `party-${randomUUID()}`, accountant = `party-${randomUUID()}`, owner = `party-${randomUUID()}`, administrator = `party-${randomUUID()}`, outsider = `party-${randomUUID()}`;
const users = [finance, auditor, accountant, owner, administrator, outsider], admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
function localGuard() { const url = new URL(process.env.MIGRATION_DATABASE_URL ?? ""); if (url.hostname !== "127.0.0.1" || url.pathname !== "/kaamledger" || url.port !== (process.env.GITHUB_ACTIONS === "true" ? "5432" : "55432")) throw new Error("Party fixtures require the dedicated local database."); }
const input = (name: string = randomUUID()) => ({ name, roleSet: ["customer", "supplier"] as ("customer" | "supplier")[], paymentTermsDays: 30, creditLimit: "250000.10" });
const create = (name?: string, company = entity) => createParty(finance, org, company, input(name), randomUUID(), randomUUID());
beforeAll(async () => {
  localGuard();
  for (const id of users) await admin.query("INSERT INTO auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Party fixture',$2,true,now(),now())", [id, `${id}@example.invalid`]);
  await admin.query("INSERT INTO organizations(id,name) VALUES($1,'Party A'),($2,'Party B')", [org, foreignOrg]);
  for (const [id, organization, actor] of [[entity, org, finance], [other, org, finance], [foreignEntity, foreignOrg, outsider]]) await admin.query("INSERT INTO legal_entities(id,organization_id,name,active_modes,reporting_profile,created_by) VALUES($1,$2,'Party company','[\"labour\"]','demo_accrual',$3)", [id, organization, actor]);
  for (const [user, role] of [[finance, "finance_manager"], [auditor, "auditor"], [accountant, "accountant"], [owner, "owner"], [administrator, "organization_admin"]]) await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,$4,$5,'[]')", [randomUUID(), org, user, JSON.stringify([role]), JSON.stringify([entity, other])]);
  await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,'[\"finance_manager\"]',$4,'[]')", [randomUUID(), foreignOrg, outsider, JSON.stringify([foreignEntity])]);
});
afterAll(async () => {
  localGuard(); const client = await admin.connect();
  const triggers = [["party_versions", "party_version_immutable"], ["parties", "party_no_delete"], ["subledger_counterparties", "subledger_immutable"], ["audit_events", "audit_append_only"]];
  try { await client.query("BEGIN"); for (const [table, trigger] of triggers) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    for (const table of ["party_versions", "parties", "subledger_counterparties", "audit_events", "idempotency_results", "memberships", "legal_entities"]) await client.query(`DELETE FROM ${table} WHERE organization_id=ANY($1::uuid[])`, [[org, foreignOrg]]);
    await client.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [[org, foreignOrg]]); await client.query("DELETE FROM auth_user WHERE id=ANY($1::text[])", [users]);
    for (const [table, trigger] of triggers) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`); await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); await admin.end(); await databasePool().end(); }
});
it("creates one durable registry identity, exact credit limit and initial master snapshot", async () => {
  const party = await create("Example both-role party");
  expect(await getParty(accountant, org, entity, party.id)).toMatchObject({ roleSet: ["customer", "supplier"], creditLimit: "250000.10", paymentTermsDays: 30, version: 1 });
  expect((await admin.query("SELECT * FROM subledger_counterparties WHERE id=$1", [party.id])).rowCount).toBe(1);
  expect((await admin.query("SELECT snapshot FROM party_versions WHERE party_id=$1", [party.id])).rows[0].snapshot.role_set).toEqual(["customer", "supplier"]);
});
it("serializes duplicate names, reserves scoped tax identifiers and permits other entities", async () => {
  const name = `Duplicate ${randomUUID()}`;
  const results = await Promise.allSettled([create(name), create(` ${name.toUpperCase().replaceAll(" ", "   ")} `)]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "23505" } });
  await create(name, other);
  const taxIdentifier = `Tax-${randomUUID()}`;
  await createParty(finance, org, entity, { ...input(), taxIdentifier }, randomUUID(), randomUUID());
  await expect(createParty(finance, org, entity, { ...input(), taxIdentifier: ` ${taxIdentifier.toUpperCase()} ` }, randomUUID(), randomUUID())).rejects.toMatchObject({ code: "23505" });
});
it("replays create exactly once and rejects conflicting payloads", async () => {
  const command = input(), key = randomUUID();
  const [a, b] = await Promise.all([createParty(finance, org, entity, command, key, randomUUID()), createParty(finance, org, entity, command, key, randomUUID())]); expect(a).toEqual(b);
  await expect(createParty(finance, org, entity, { ...command, name: "Different" }, key, randomUUID())).rejects.toMatchObject({ status: 409 });
  expect((await admin.query("SELECT * FROM audit_events WHERE target_id=$1", [a.id])).rowCount).toBe(1);
});
it("denies role escalation, cross-organization and cross-entity reads and writes", async () => {
  const party = await create();
  for (const user of [owner, administrator]) await expect(getParty(user, org, entity, party.id)).rejects.toMatchObject({ status: 403 });
  await expect(getParty(outsider, org, entity, party.id)).rejects.toMatchObject({ status: 404 });
  for (const user of [auditor, accountant]) await expect(createParty(user, org, entity, input(), randomUUID(), randomUUID())).rejects.toMatchObject({ status: 403 });
  await expect(getParty(finance, org, other, party.id)).rejects.toMatchObject({ status: 404 });
  for (const user of [owner, administrator]) expect(await withScope(user, org, entity, "entity.read", async c => (await c.query("SELECT id FROM parties WHERE id=$1", [party.id])).rowCount)).toBe(0);
  const second = await create(undefined, other);
  expect(await withScope(finance, org, entity, "parties.read", async c => (await c.query("SELECT id FROM parties WHERE id=$1", [second.id])).rowCount)).toBe(0);
  for (const user of [owner, administrator, auditor]) expect(await withScope(user, org, entity, "entity.read", async c => (await c.query("UPDATE parties SET name='forged',version=version+1 WHERE id=$1 RETURNING id", [party.id])).rowCount)).toBe(0);
});
it("concurrent PATCH commits one retained version; null clearing differs from omitted fields", async () => {
  const party = await create();
  const results = await Promise.allSettled([patchParty(finance, org, entity, party.id, { contact: "First" }, 1, randomUUID()), patchParty(finance, org, entity, party.id, { contact: "Second" }, 1, randomUUID())]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { status: 412 } });
  const next = await patchParty(finance, org, entity, party.id, { contact: null, paymentTermsDays: 0, creditLimit: "0" }, 2, randomUUID()); expect(next).toMatchObject({ contact: null, paymentTermsDays: 0, creditLimit: "0.00", version: 3 });
  expect((await admin.query("SELECT snapshot FROM party_versions WHERE party_id=$1 ORDER BY version", [party.id])).rows.map(r => r.snapshot.payment_terms_days)).toEqual([30, 30, 0]);
});
it("rejects forged identity, actor, version, archive metadata and historical snapshots", async () => {
  const party = await create();
  for (const edit of ["created_by='unknown'", `legal_entity_id='${other}'`, "archived_at=now()", "role_set='[]'", "payment_terms_days=-1"]) await expect(withScope(finance, org, entity, "parties.update", c => c.query(`UPDATE parties SET ${edit},version=version+1,updated_by=$2 WHERE id=$1`, [party.id, finance]))).rejects.toBeDefined();
  await expect(withScope(finance, org, entity, "parties.update", c => c.query("UPDATE parties SET name='Unversioned',updated_by=$2 WHERE id=$1", [party.id, finance]))).rejects.toBeDefined();
  await expect(withScope(finance, org, entity, "parties.update", c => c.query("UPDATE parties SET version=version+1,updated_by=$2 WHERE id=$1", [party.id, auditor]))).rejects.toBeDefined();
  await expect(withScope(finance, org, entity, "parties.update", c => c.query("DELETE FROM parties WHERE id=$1", [party.id]))).rejects.toMatchObject({ code: "42501" });
  await expect(withScope(finance, org, entity, "parties.update", c => c.query("UPDATE party_versions SET snapshot='{}' WHERE party_id=$1", [party.id]))).rejects.toMatchObject({ code: "42501" });
});
it("archives idempotently, retains identity and history, reserves names and denies reactivation", async () => {
  const party = await create(), reason = { reason: "Retired settled counterparty" }, key = randomUUID();
  const [a, b] = await Promise.all([archiveParty(finance, org, entity, party.id, reason, 1, key, randomUUID()), archiveParty(finance, org, entity, party.id, reason, 1, key, randomUUID())]); expect(a).toEqual(b); expect(a).toMatchObject({ active: false, version: 2, archiveReason: reason.reason });
  await expect(patchParty(finance, org, entity, party.id, { name: "Reopened" }, 2, randomUUID())).rejects.toMatchObject({ code: "PARTY_ARCHIVED" });
  await expect(create(party.name)).rejects.toMatchObject({ code: "23505" });
  expect((await listParties(auditor, org, entity, 100)).data.some(p => p.id === party.id && !p.active)).toBe(true);
  expect((await listAudit(auditor, org, entity, { limit: 100, targetType: "party", targetId: party.id })).data.map(e => e.action)).toEqual(expect.arrayContaining(["party.create", "party.archive"]));
});
it("revocation denies old idempotent commands; pages are bounded and scoped", async () => {
  const command = input(), key = randomUUID(); await createParty(finance, org, entity, command, key, randomUUID());
  try { await admin.query("UPDATE memberships SET roles='[\"accountant\"]',version=version+1 WHERE organization_id=$1 AND user_id=$2", [org, finance]);
    await expect(createParty(finance, org, entity, command, key, randomUUID())).rejects.toMatchObject({ status: 403 });
  } finally { await admin.query("UPDATE memberships SET roles='[\"finance_manager\"]',version=version+1 WHERE organization_id=$1 AND user_id=$2", [org, finance]); }
  const page = await listParties(auditor, org, entity, 1); expect(page.nextCursor).not.toBeNull(); expect((await listParties(auditor, org, entity, 1, page.nextCursor!)).data[0].id).not.toBe(page.data[0].id);
  await expect(listParties(auditor, org, entity, 101)).rejects.toBeDefined();
});
it("snapshot failure rolls master, registry, audit and replay state back together", async () => {
  const marker = `Fault ${randomUUID()}`, key = randomUUID();
  await admin.query(`CREATE FUNCTION app_security.party_capture_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.snapshot->>'name'='${marker}' THEN RAISE EXCEPTION 'Injected snapshot failure'; END IF; RETURN NEW; END $$`);
  await admin.query("CREATE TRIGGER party_capture_fault BEFORE INSERT ON party_versions FOR EACH ROW EXECUTE FUNCTION app_security.party_capture_fault()");
  const before = (await admin.query("SELECT count(*)::text AS count FROM subledger_counterparties WHERE organization_id=$1", [org])).rows[0].count;
  try {
    await expect(createParty(finance, org, entity, input(marker), key, randomUUID())).rejects.toMatchObject({ code: "P0001" });
    expect((await admin.query("SELECT * FROM parties WHERE organization_id=$1 AND name=$2", [org, marker])).rowCount).toBe(0);
    expect((await admin.query("SELECT count(*)::text AS count FROM subledger_counterparties WHERE organization_id=$1", [org])).rows[0].count).toBe(before);
    expect((await admin.query("SELECT * FROM idempotency_results WHERE organization_id=$1 AND key=$2", [org, key])).rowCount).toBe(0);
  } finally { await admin.query("DROP TRIGGER party_capture_fault ON party_versions"); await admin.query("DROP FUNCTION app_security.party_capture_fault()"); }
  expect((await createParty(finance, org, entity, input(marker), key, randomUUID())).version).toBe(1);
});
