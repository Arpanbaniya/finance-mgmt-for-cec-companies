import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, expect, it } from "vitest";
import { databasePool } from "@/db/client";
import { withScope } from "@/features/identity/scope";
import { createAccount, patchAccount, archiveAccount } from "@/features/accounting/accounts-service";
import { createJournal, patchJournal, cancelJournal, getJournal, listJournals } from "@/features/accounting/journal-service";
config({ path: ".env.local", quiet: true });
const org = randomUUID(), entity = randomUUID(), otherEntity = randomUUID();
const finance = `draft-${randomUUID()}`, maker = `draft-${randomUUID()}`, auditor = `draft-${randomUUID()}`, administrator = `draft-${randomUUID()}`;
const users = [finance, maker, auditor, administrator], admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
let expense = "", equity = "", control = "", branch = "";
const body = (amount = "10.00") => ({ postingDate: "2026-10-10", documentDate: "2026-10-09", description: "Fictional journal draft", lines: [{ accountId: expense, debit: amount, credit: "0.00", dimensions: { branchId: branch } }, { accountId: equity, debit: "0.00", credit: amount, dimensions: {} }] });
const create = (key = randomUUID(), input = body()) => createJournal(maker, org, entity, input, key, randomUUID());
beforeAll(async () => {
  const url = new URL(process.env.MIGRATION_DATABASE_URL ?? ""); if (url.hostname !== "127.0.0.1" || url.pathname !== "/kaamledger") throw new Error("Draft fixtures require the dedicated local database.");
  for (const id of users) await admin.query("INSERT INTO auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Draft fixture',$2,true,now(),now())", [id, `${id}@example.invalid`]);
  await admin.query("INSERT INTO organizations(id,name) VALUES($1,'Draft test organization')", [org]);
  for (const id of [entity, otherEntity]) await admin.query("INSERT INTO legal_entities(id,organization_id,name,active_modes,reporting_profile,created_by) VALUES($1,$2,'Draft company','[\"labour\"]','demo_accrual',$3)", [id, org, finance]);
  for (const [id, role] of [[finance, "finance_manager"], [maker, "accountant"], [auditor, "auditor"], [administrator, "organization_admin"]]) await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,$4,$5,'[]')", [randomUUID(), org, id, JSON.stringify([role]), JSON.stringify([entity, otherEntity])]);
  for (const type of ["expense", "equity"] as const) {
    const a = await createAccount(finance, org, entity, { code: type, name: type, type, normalSide: type === "expense" ? "debit" : "credit", isControl: false, reportMapping: { statementSection: type === "expense" ? "expenses" : "equity", cashFlowCategory: "unclassified" } }, randomUUID(), randomUUID());
    if (type === "expense") expense = a.id; else equity = a.id;
  }
  control = (await createAccount(finance, org, entity, { code: "CASH", name: "Cash control", type: "asset", normalSide: "debit", isControl: true, controlType: "cash", reportMapping: { statementSection: "assets", cashFlowCategory: "cash" } }, randomUUID(), randomUUID())).id;
  branch = randomUUID(); await admin.query("INSERT INTO branches(id,organization_id,legal_entity_id,name) VALUES($1,$2,$3,'Draft branch')", [branch, org, entity]);
});
afterAll(async () => {
  const url = new URL(process.env.MIGRATION_DATABASE_URL ?? ""); if (url.hostname !== "127.0.0.1" || url.pathname !== "/kaamledger") { await admin.end(); return; }
  const client = await admin.connect(), triggers = [["manual_journal_results", "manual_result_immutable"], ["manual_journal_revisions", "manual_revision_immutable"], ["manual_journal_drafts", "manual_draft_no_delete"], ["accounts", "account_no_delete"], ["account_versions", "account_version_append_only"], ["audit_events", "audit_append_only"]];
  try { await client.query("BEGIN"); for (const [table, trigger] of triggers) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    for (const table of ["manual_journal_results", "manual_journal_revisions", "manual_journal_drafts", "account_versions", "accounts", "branches", "audit_events", "idempotency_results", "memberships", "legal_entities"]) await client.query(`DELETE FROM ${table} WHERE organization_id=$1`, [org]);
    await client.query("DELETE FROM organizations WHERE id=$1", [org]); await client.query("DELETE FROM auth_user WHERE id=ANY($1::text[])", [users]);
    for (const [table, trigger] of triggers) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`); await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); await admin.end(); await databasePool().end(); }
});
it("concurrent create replay retains exact original draft, master versions and one audit", async () => {
  const key = randomUUID(), [a, b] = await Promise.all([create(key), create(key)]); expect(a).toEqual(b); expect(a).toMatchObject({ status: "draft", version: 1, debit: "10.00", createdBy: maker, lines: [{ accountVersion: 1 }, { accountVersion: 1 }] });
  await patchJournal(maker, org, entity, a.id, { description: "Changed later" }, 1, randomUUID());
  expect(await create(key)).toEqual(a); await expect(create(key, { ...body(), description: "Different request" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect((await admin.query("SELECT * FROM manual_journal_revisions WHERE draft_id=$1", [a.id])).rowCount).toBe(2);
  expect((await admin.query("SELECT * FROM audit_events WHERE target_id=$1 AND action='journal.draft.create'", [a.id])).rowCount).toBe(1);
});
it("exact decimal amounts above JavaScript safe integers survive create, read and replay", async () => {
  const key = randomUUID(), a = await create(key, body("999999999999999999.99")); expect(a.debit).toBe("999999999999999999.99"); expect((await getJournal(auditor, org, entity, a.id)).credit).toBe(a.credit); expect(await create(key, body(a.debit))).toEqual(a);
});
it("competing patches produce one new version and one stale loser without overwriting", async () => {
  const a = await create(), outcomes = await Promise.allSettled(["Edit A", "Edit B"].map(description => patchJournal(maker, org, entity, a.id, { description }, 1, randomUUID())));
  expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1); expect(outcomes.find(outcome => outcome.status === "rejected")).toMatchObject({ reason: { code: "STALE_VERSION", status: 412 } });
  const current = await getJournal(maker, org, entity, a.id); expect(current.version).toBe(2); expect(current.lines).toEqual(a.lines);
});
it("cancel is reasoned, durable, append-only and prevents further changes", async () => {
  const a = await create(), key = randomUUID(), request = randomUUID(), result = await cancelJournal(maker, org, entity, a.id, { reason: "No longer needed" }, 1, key, request);
  expect(await cancelJournal(maker, org, entity, a.id, { reason: "No longer needed" }, 1, key, randomUUID())).toEqual(result); expect(result.requestId).toBe(request);
  await expect(patchJournal(maker, org, entity, a.id, { description: "Overwrite cancelled" }, 2, randomUUID())).rejects.toMatchObject({ code: "INVALID_STATE" });
  await expect(cancelJournal(maker, org, entity, a.id, { reason: "Changed reason" }, 1, key, randomUUID())).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect((await getJournal(auditor, org, entity, a.id)).cancelReason).toBe("No longer needed");
  for (const table of ["manual_journal_results", "manual_journal_revisions"]) await expect(admin.query(`UPDATE ${table} SET ${table === "manual_journal_results" ? "result" : "snapshot"}='{}' WHERE draft_id=$1`, [a.id])).rejects.toThrow(/append-only/);
});
it("current role, scope and revocation protect services, direct functions and replay", async () => {
  const key = randomUUID(), a = await create(key); expect((await getJournal(auditor, org, entity, a.id)).id).toBe(a.id);
  await expect(getJournal(maker, org, otherEntity, a.id)).rejects.toMatchObject({ status: 404 });
  for (const actor of [auditor, administrator]) await expect(createJournal(actor, org, entity, body(), randomUUID(), randomUUID())).rejects.toMatchObject({ status: 403 });
  await expect(withScope(auditor, org, entity, "journals.read", c => c.query("SELECT app_security.save_manual_journal_draft($1,$2,NULL,NULL,$3,$4,$5)", [org, entity, JSON.stringify(body()), randomUUID(), randomUUID()]))).rejects.toThrow("FORBIDDEN");
  await expect(databasePool().query("SELECT app_security.save_manual_journal_draft($1,$2,NULL,NULL,$3,$4,$5)", [org, entity, JSON.stringify(body()), randomUUID(), randomUUID()])).rejects.toThrow("FORBIDDEN");
  expect((await databasePool().query("SELECT * FROM manual_journal_drafts")).rowCount).toBe(0);
  await admin.query("UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2", [org, maker]);
  try { await expect(create(key)).rejects.toMatchObject({ status: 404 }); } finally { await admin.query("UPDATE memberships SET active=true WHERE organization_id=$1 AND user_id=$2", [org, maker]); }
});
it("runtime direct writes and forged receipts remain denied", async () => {
  for (const table of ["manual_journal_drafts", "manual_journal_revisions", "manual_journal_results"]) for (const sql of [`INSERT INTO ${table} DEFAULT VALUES`, `UPDATE ${table} SET ${table === "manual_journal_drafts" ? "status='cancelled'" : table === "manual_journal_revisions" ? "snapshot='{}'" : "result='{}'"}`, `DELETE FROM ${table}`, `TRUNCATE ${table}`]) await expect(withScope(finance, org, entity, "journals.update", c => c.query(sql))).rejects.toThrow(/permission denied/);
  await expect(withScope(finance, org, entity, "journals.read", c => c.query("SELECT * FROM manual_journal_results"))).rejects.toThrow(/permission denied/);
});
it("control, cross-company, archived and nonexistent accounts and branches are rejected", async () => {
  for (const [accountId, code] of [[control, "CONTROL_ACCOUNT_FORBIDDEN"], [randomUUID(), "ACCOUNT_UNAVAILABLE"]]) await expect(create(randomUUID(), { ...body(), lines: [{ ...body().lines[0], accountId }, body().lines[1]] })).rejects.toMatchObject({ code });
  await expect(create(randomUUID(), { ...body(), lines: [{ ...body().lines[0], dimensions: { branchId: randomUUID() } }, body().lines[1]] })).rejects.toMatchObject({ code: "DIMENSION_UNAVAILABLE" });
  await expect(createJournal(finance, org, otherEntity, body(), randomUUID(), randomUUID())).rejects.toMatchObject({ code: "ACCOUNT_UNAVAILABLE" });
});
it("direct SQL validates the finite draft vocabulary and cannot bypass exact balance", async () => {
  for (const input of [{ ...body(), status: "posted" }, { ...body(), lines: [{ ...body().lines[0], accountVersion: 1 }, body().lines[1]] }, { ...body(), lines: [{ ...body().lines[0], debit: "10.01" }, body().lines[1]] }, { ...body(), lines: [{ ...body().lines[0], debit: 10 }, body().lines[1]] }, { ...body(), lines: [{ ...body().lines[0], dimensions: { workerId: randomUUID() } }, body().lines[1]] }]) {
    await expect(withScope(maker, org, entity, "journals.create", c => c.query("SELECT app_security.save_manual_journal_draft($1,$2,NULL,NULL,$3,$4,$5)", [org, entity, JSON.stringify(input), randomUUID(), randomUUID()]))).rejects.toThrow(/INVALID_CONTENT|UNBALANCED_JOURNAL/);
  }
});
it("audit failure rolls back the head, revision and private command receipt", async () => {
  const constraint = `draft_fault_${randomUUID().replaceAll("-", "")}`, before = (await admin.query("SELECT count(*)::int AS count FROM manual_journal_drafts WHERE organization_id=$1", [org])).rows[0].count;
  await admin.query(`ALTER TABLE audit_events ADD CONSTRAINT ${constraint} CHECK (organization_id<>'${org}'::uuid OR action<>'journal.draft.create') NOT VALID`);
  const key = randomUUID();
  try { await expect(create(key)).rejects.toMatchObject({ code: "23514" }); expect((await admin.query("SELECT count(*)::int AS count FROM manual_journal_drafts WHERE organization_id=$1", [org])).rows[0].count).toBe(before); expect((await admin.query("SELECT * FROM manual_journal_results WHERE organization_id=$1 AND key=$2", [org, key])).rowCount).toBe(0); }
  finally { await admin.query(`ALTER TABLE audit_events DROP CONSTRAINT ${constraint}`); }
  expect((await create(key)).version).toBe(1);
});
it("a patch/cancel race commits only one transition from the expected version", async () => {
  const a = await create(), outcomes = await Promise.allSettled([patchJournal(maker, org, entity, a.id, { description: "Race edit" }, 1, randomUUID()), cancelJournal(finance, org, entity, a.id, { reason: "Race cancellation" }, 1, randomUUID(), randomUUID())]);
  expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1); expect(outcomes.find(outcome => outcome.status === "rejected")).toMatchObject({ reason: { code: "STALE_VERSION" } });
  expect((await admin.query("SELECT * FROM manual_journal_revisions WHERE draft_id=$1", [a.id])).rowCount).toBe(2);
});
it("server resolves current account versions while earlier saved revisions remain unchanged", async () => {
  const a = await create(); await patchAccount(finance, org, entity, expense, { name: "New expense name" }, 1, randomUUID());
  const changed = await patchJournal(maker, org, entity, a.id, { description: "Revalidated accounts" }, 1, randomUUID()); expect(changed.lines[0].accountVersion).toBe(2);
  const snapshot = (await admin.query("SELECT snapshot FROM manual_journal_revisions WHERE draft_id=$1 AND version=1", [a.id])).rows[0].snapshot; expect(snapshot.body.lines[0].accountVersion).toBe(1);
  await archiveAccount(finance, org, entity, expense, { reason: "Unused ordinary account" }, 2, randomUUID(), randomUUID());
  await expect(patchJournal(maker, org, entity, a.id, { description: "Archived account no longer valid" }, 2, randomUUID())).rejects.toMatchObject({ code: "ACCOUNT_UNAVAILABLE" });
  expect((await getJournal(auditor, org, entity, a.id)).lines[0].accountVersion).toBe(2);
});
it("draft and cancellation never allocate a number or create a financial source or ledger", async () => {
  for (const table of ["journal_entries", "document_numbers", "journal_posting_sources", "journal_posting_events"]) expect((await admin.query(`SELECT * FROM ${table} WHERE organization_id=$1`, [org])).rowCount).toBe(0);
  const page = await listJournals(auditor, org, entity, 2); expect(page.data).toHaveLength(2); expect(page.nextCursor).toBe(page.data[1].id); expect((await listJournals(auditor, org, entity, 100, page.nextCursor!)).data.every(draft => draft.id > page.nextCursor!)).toBe(true);
});
