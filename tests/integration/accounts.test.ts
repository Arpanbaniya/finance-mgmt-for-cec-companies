import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, expect, it } from "vitest";
import { databasePool } from "@/db/client";
import { withScope } from "@/features/identity/scope";
import { createAccount, getAccount, listAccounts, patchAccount, archiveAccount } from "@/features/accounting/accounts-service";
import { listAudit } from "@/features/approvals/service";
config({ path: ".env.local", quiet: true });
const org = randomUUID(), foreignOrg = randomUUID(), entity = randomUUID(), secondEntity = randomUUID(), foreignEntity = randomUUID();
const finance = `chart-${randomUUID()}`, auditor = `chart-${randomUUID()}`, administrator = `chart-${randomUUID()}`, outsider = `chart-${randomUUID()}`;
const users = [finance, auditor, administrator, outsider], admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const input = (code: string = randomUUID()) => ({ code, name: "Ordinary asset", type: "asset" as const, normalSide: "debit" as const, isControl: false, reportMapping: { statementSection: "assets" as const, cashFlowCategory: "unclassified" as const } });
const create = (code?: string, parentId?: string) => createAccount(finance, org, entity, { ...input(code), parentId: parentId ?? null }, randomUUID(), randomUUID());
beforeAll(async () => {
  const url = new URL(process.env.MIGRATION_DATABASE_URL ?? ""); if (url.hostname !== "127.0.0.1" || url.pathname !== "/kaamledger") throw new Error("Account fixtures require the dedicated local database.");
  for (const id of users) await admin.query("INSERT INTO auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Chart fixture',$2,true,now(),now())", [id, `${id}@example.invalid`]);
  await admin.query("INSERT INTO organizations(id,name) VALUES($1,'Chart A'),($2,'Chart B')", [org, foreignOrg]);
  for (const [id, organization, actor] of [[entity, org, finance], [secondEntity, org, finance], [foreignEntity, foreignOrg, outsider]]) await admin.query("INSERT INTO legal_entities(id,organization_id,name,active_modes,reporting_profile,created_by) VALUES($1,$2,'Chart company','[\"labour\"]','demo_accrual',$3)", [id, organization, actor]);
  for (const [user, role] of [[finance, "finance_manager"], [auditor, "auditor"], [administrator, "organization_admin"]]) await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,$4,$5,'[]')", [randomUUID(), org, user, JSON.stringify([role]), JSON.stringify([entity, secondEntity])]);
  await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,'[\"finance_manager\"]',$4,'[]')", [randomUUID(), foreignOrg, outsider, JSON.stringify([foreignEntity])]);
});
afterAll(async () => {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    for (const [table, trigger] of [["audit_events", "audit_append_only"], ["account_versions", "account_version_append_only"], ["accounts", "account_no_delete"]]) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    for (const table of ["account_versions", "accounts", "audit_events", "idempotency_results", "memberships", "legal_entities"]) await client.query(`DELETE FROM ${table} WHERE organization_id=ANY($1::uuid[])`, [[org, foreignOrg]]);
    await client.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [[org, foreignOrg]]); await client.query("DELETE FROM auth_user WHERE id=ANY($1::text[])", [users]);
    for (const [table, trigger] of [["audit_events", "audit_append_only"], ["account_versions", "account_version_append_only"], ["accounts", "account_no_delete"]]) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); await admin.end(); await databasePool().end(); }
});
it("concurrent canonical create replay commits one account, immutable version and audit", async () => {
  const key = randomUUID(), data = input("test-01");
  const [a, b] = await Promise.all([createAccount(finance, org, entity, data, key, randomUUID()), createAccount(finance, org, entity, { ...data, code: " TEST-01 " }, key, randomUUID())]);
  expect(a).toEqual(b); expect(a.code).toBe("TEST-01"); expect(a.version).toBe(1);
  expect((await admin.query("SELECT * FROM accounts WHERE organization_id=$1 AND code='TEST-01'", [org])).rowCount).toBe(1);
  expect((await admin.query("SELECT * FROM account_versions WHERE account_id=$1", [a.id])).rowCount).toBe(1);
  expect((await admin.query("SELECT * FROM audit_events WHERE target_id=$1", [a.id])).rowCount).toBe(1);
  await expect(createAccount(finance, org, entity, { ...data, name: "Changed" }, key, randomUUID())).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await patchAccount(finance, org, entity, a.id, { name: "Edited later" }, 1, randomUUID());
  expect(await createAccount(finance, org, entity, data, key, randomUUID())).toEqual(a);
});
it("normalized duplicate codes cannot race through, but companies can use separate charts", async () => {
  const data = input("duplicate"), results = await Promise.allSettled([createAccount(finance, org, entity, data, randomUUID(), randomUUID()), createAccount(finance, org, entity, data, randomUUID(), randomUUID())]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1); expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "23505" } });
  expect((await createAccount(finance, org, secondEntity, data, randomUUID(), randomUUID())).code).toBe("DUPLICATE");
});
it("entity-scoped read and SQL RLS reject guessed IDs, pooled leakage and ordinary admin mutation", async () => {
  const account = await create();
  expect((await databasePool().query("SELECT * FROM accounts")).rows).toEqual([]); expect((await databasePool().query("SELECT * FROM account_versions")).rows).toEqual([]);
  expect((await getAccount(auditor, org, entity, account.id)).id).toBe(account.id);
  await expect(getAccount(finance, org, secondEntity, account.id)).rejects.toMatchObject({ status: 404 });
  await expect(getAccount(outsider, foreignOrg, foreignEntity, account.id)).rejects.toMatchObject({ status: 404 });
  for (const actor of [auditor, administrator]) await expect(createAccount(actor, org, entity, input(), randomUUID(), randomUUID())).rejects.toMatchObject({ status: 403 });
  expect((await withScope(auditor, org, entity, "accounts.read", c => c.query("UPDATE accounts SET name='Not allowed',version=version+1,updated_by=$2 WHERE id=$1 RETURNING id", [account.id, auditor]))).rowCount).toBe(0);
  expect((await withScope(finance, org, secondEntity, "accounts.read", c => c.query("SELECT * FROM accounts WHERE id=$1", [account.id]))).rowCount).toBe(0);
});
it("parents must exist in the same company with compatible active ordinary classification", async () => {
  const parent = await create(), child = await create(undefined, parent.id);
  expect(child.parentId).toBe(parent.id);
  await expect(createAccount(finance, org, secondEntity, { ...input(), parentId: parent.id }, randomUUID(), randomUUID())).rejects.toMatchObject({ status: 404 });
  const cash = await createAccount(finance, org, entity, { ...input(), isControl: true, controlType: "cash", reportMapping: { statementSection: "assets", cashFlowCategory: "cash" } }, randomUUID(), randomUUID());
  await expect(create(undefined, cash.id)).rejects.toMatchObject({ code: "INVALID_ACCOUNT_PARENT" });
  await expect(createAccount(finance, org, entity, { ...input(), type: "expense", parentId: parent.id, reportMapping: { statementSection: "expenses", cashFlowCategory: "unclassified" } }, randomUUID(), randomUUID())).rejects.toMatchObject({ code: "INVALID_ACCOUNT_PARENT" });
  const archived = await create(); await archiveAccount(finance, org, entity, archived.id, { reason: "Unused account" }, 1, randomUUID(), randomUUID());
  await expect(create(undefined, archived.id)).rejects.toMatchObject({ code: "INVALID_ACCOUNT_PARENT" });
});
it("hierarchy cycles and direct SQL classification changes fail without losing history", async () => {
  const parent = await create(), child = await create(undefined, parent.id), grandchild = await create(undefined, child.id);
  await expect(patchAccount(finance, org, entity, parent.id, { parentId: grandchild.id }, 1, randomUUID())).rejects.toMatchObject({ code: "ACCOUNT_CYCLE" });
  await expect(withScope(finance, org, entity, "accounts.update", c => c.query("UPDATE accounts SET parent_id=$2,version=version+1,updated_by=$3 WHERE id=$1", [parent.id, grandchild.id, finance]))).rejects.toMatchObject({ code: "P0001" });
  for (const sql of ["code='NEWCODE'", "type='liability'", "normal_side='credit'", "is_control=true,control_type='ar'", "legal_entity_id='" + secondEntity + "'"]) await expect(withScope(finance, org, entity, "accounts.update", c => c.query(`UPDATE accounts SET ${sql},version=version+1,updated_by=$2 WHERE id=$1`, [parent.id, finance]))).rejects.toBeDefined();
  for (const table of ["accounts", "account_versions"]) await expect(databasePool().query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: "42501" });
  await expect(databasePool().query("UPDATE account_versions SET snapshot='{}'")).rejects.toMatchObject({ code: "42501" });
  await expect(admin.query("UPDATE account_versions SET snapshot='{}' WHERE account_id=$1", [parent.id])).rejects.toMatchObject({ code: "P0001" });
});
it("concurrent edits yield one new version and retain previous mapping; clearing parent is explicit", async () => {
  const parent = await create(), account = await create(undefined, parent.id);
  const results = await Promise.allSettled([patchAccount(finance, org, entity, account.id, { name: "Changed A" }, 1, randomUUID()), patchAccount(finance, org, entity, account.id, { name: "Changed B" }, 1, randomUUID())]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1); expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { status: 412 } });
  const cleared = await patchAccount(finance, org, entity, account.id, { parentId: null, reportMapping: { statementSection: "assets", cashFlowCategory: "investing" } }, 2, randomUUID());
  expect(cleared.parentId).toBeNull(); expect(cleared.version).toBe(3);
  const history = (await admin.query("SELECT * FROM account_versions WHERE account_id=$1 ORDER BY version", [account.id])).rows;
  expect(history).toHaveLength(3); expect(history[0].snapshot.parent_id).toBe(parent.id); expect(history[0].snapshot.cash_flow_category).toBe("unclassified");
  expect(history[2].snapshot.cash_flow_category).toBe("investing");
});
it("archive blocks active children, keeps code reserved, and replays immutable original result", async () => {
  const parent = await create(), child = await create(undefined, parent.id), reason = { reason: "Retired unused chart branch" }, key = randomUUID();
  await expect(archiveAccount(finance, org, entity, parent.id, reason, 1, randomUUID(), randomUUID())).rejects.toMatchObject({ code: "ACCOUNT_DEPENDENCIES" });
  await archiveAccount(finance, org, entity, child.id, reason, 1, randomUUID(), randomUUID());
  const [a, b] = await Promise.all([archiveAccount(finance, org, entity, parent.id, reason, 1, key, randomUUID()), archiveAccount(finance, org, entity, parent.id, reason, 1, key, randomUUID())]);
  expect(a).toEqual(b); expect(a).toMatchObject({ active: false, version: 2, archiveReason: reason.reason, archivedBy: finance });
  await expect(patchAccount(finance, org, entity, parent.id, { name: "Reopened" }, 2, randomUUID())).rejects.toMatchObject({ code: "ACCOUNT_ARCHIVED" });
  await expect(create(parent.code)).rejects.toMatchObject({ code: "23505" });
  expect((await admin.query("SELECT * FROM audit_events WHERE target_id=$1 AND action='account.archive'", [parent.id])).rowCount).toBe(1);
  expect((await listAccounts(auditor, org, entity, 100)).data.some(a => a.id === parent.id && !a.active)).toBe(true);
});
it("revoked finance authority denies replay and metadata audit remains scoped", async () => {
  const key = randomUUID(), data = input(), account = await createAccount(finance, org, entity, data, key, randomUUID());
  try {
    await admin.query("UPDATE memberships SET roles='[\"accountant\"]',version=version+1 WHERE organization_id=$1 AND user_id=$2", [org, finance]);
    await expect(createAccount(finance, org, entity, data, key, randomUUID())).rejects.toMatchObject({ status: 403 });
    await expect(patchAccount(finance, org, entity, account.id, { name: "Changed" }, 1, randomUUID())).rejects.toMatchObject({ status: 403 });
  } finally { await admin.query("UPDATE memberships SET roles='[\"finance_manager\"]',version=version+1 WHERE organization_id=$1 AND user_id=$2", [org, finance]); }
  const history = await listAudit(auditor, org, entity, { limit: 100, targetType: "account", targetId: account.id });
  expect(history.data).toHaveLength(1); expect(history.data[0].action).toBe("account.create"); expect(history.data[0]).not.toHaveProperty("snapshot");
});
it("failed version capture rolls account, audit and replay store back together", async () => {
  const key = randomUUID(), data = input("capture-fault");
  await admin.query("CREATE FUNCTION app_security.account_capture_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.snapshot->>'code'='CAPTURE-FAULT' THEN RAISE EXCEPTION 'Injected snapshot failure'; END IF; RETURN NEW; END $$");
  await admin.query("CREATE TRIGGER account_capture_fault BEFORE INSERT ON account_versions FOR EACH ROW EXECUTE FUNCTION app_security.account_capture_fault()");
  try {
    await expect(createAccount(finance, org, entity, data, key, randomUUID())).rejects.toMatchObject({ code: "P0001" });
    expect((await admin.query("SELECT * FROM accounts WHERE organization_id=$1 AND code='CAPTURE-FAULT'", [org])).rowCount).toBe(0);
    expect((await admin.query("SELECT * FROM idempotency_results WHERE organization_id=$1 AND key=$2", [org, key])).rowCount).toBe(0);
  } finally { await admin.query("DROP TRIGGER account_capture_fault ON account_versions"); await admin.query("DROP FUNCTION app_security.account_capture_fault()"); }
  expect((await createAccount(finance, org, entity, data, key, randomUUID())).version).toBe(1);
});
it("cursor pages are scoped and bounded without dropping archived account history", async () => {
  const first = await listAccounts(finance, org, entity, 1); expect(first.nextCursor).not.toBeNull();
  const next = await listAccounts(finance, org, entity, 1, first.nextCursor!); expect(next.data[0].id).not.toBe(first.data[0].id);
  expect((await listAccounts(auditor, org, secondEntity, 100)).data.every(account => account.entityId === secondEntity)).toBe(true);
});
it("racing reciprocal reparenting cannot commit a hierarchy cycle", async () => {
  const a = await create(), b = await create();
  const results = await Promise.allSettled([patchAccount(finance, org, entity, a.id, { parentId: b.id }, 1, randomUUID()), patchAccount(finance, org, entity, b.id, { parentId: a.id }, 1, randomUUID())]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "ACCOUNT_CYCLE" } });
});
it("archive versus child creation serializes without leaving an active child below an archived parent", async () => {
  const parent = await create();
  const results = await Promise.allSettled([archiveAccount(finance, org, entity, parent.id, { reason: "Retired branch" }, 1, randomUUID(), randomUUID()), create(undefined, parent.id)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const invalid = await admin.query("SELECT 1 FROM accounts c JOIN accounts p ON p.id=c.parent_id WHERE p.id=$1 AND c.active AND NOT p.active", [parent.id]);
  expect(invalid.rowCount).toBe(0);
});
