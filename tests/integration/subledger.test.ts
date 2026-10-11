import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { beforeAll, afterAll, expect, it } from "vitest";
import { databasePool } from "@/db/client";
import { withScope } from "@/features/identity/scope";
import { createAccount, patchAccount } from "@/features/accounting/accounts-service";
import { createFiscalYear } from "@/features/accounting/setup-service";
import { readOpenBalances, writeSubledgerSource } from "@/features/accounting/subledger-service";
import type { SubledgerSourceValue } from "@/domain/subledger-source";
import { readGeneralLedger } from "@/features/reporting/general-ledger-service";
import { readStatementFoundation } from "@/features/reporting/statement-service";
config({ path: ".env.local", quiet: true });
const org = randomUUID(), entity = randomUUID(), other = randomUUID(), party = randomUUID(), otherParty = randomUUID();
const finance = `subledger-${randomUUID()}`, reader = `subledger-${randomUUID()}`, users = [finance, reader];
const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const accounts: Record<string, string> = {};
const knownAt = "9999-12-31T23:59:59.999999Z";
async function internal<T>(work: (client: PoolClient) => Promise<T>, company = entity) {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id',$1,true),set_config('app.org_id',$2,true),set_config('app.entity_id',$3,true)", [finance, org, company]);
    const result = await work(client); await client.query("COMMIT"); return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
const post = (input: SubledgerSourceValue, source = randomUUID()) => internal(client => writeSubledgerSource(client, org, entity, source, input, randomUUID()));
function item(side: "ar" | "ap" = "ar", amount = "3000.00", counterparty = party): SubledgerSourceValue {
  return { kind: side === "ar" ? "ar_item" : "ap_item", postingDate: "2026-01-01", documentDate: "2025-12-30", dueDate: "2026-01-31", partyId: counterparty, amount, controlAccountId: accounts[side], counterAccountId: accounts[side === "ar" ? "revenue" : "expense"] };
}
function deposit(side: "ar" | "ap" = "ar", amount = "5000.00", counterparty = party): SubledgerSourceValue {
  return { kind: side === "ar" ? "ar_deposit" : "ap_advance", postingDate: "2026-01-10", documentDate: "2026-01-10", partyId: counterparty, amount, controlAccountId: accounts[side === "ar" ? "customer_deposits" : "supplier_advances"], counterAccountId: accounts.cash };
}
async function pair(side: "ar" | "ap" = "ar", amount = "3000.00", sourceAmount = "5000.00") {
  const itemSource = randomUUID(), settlement = randomUUID(); await post(item(side, amount), itemSource); await post(deposit(side, sourceAmount), settlement);
  const target = (await admin.query("SELECT id FROM subledger_open_items WHERE source_id=$1", [itemSource])).rows[0].id as string;
  return { target, settlement, itemSource };
}
const apply = (settlement: string, target: string, amount = "3000.00", date = "2026-02-01"): SubledgerSourceValue => ({ kind: "application", settlementId: settlement, openItemId: target, amount, postingDate: date, documentDate: date });
const balance = async (target: string, date = "2026-12-31", instant = knownAt) => (await readOpenBalances(reader, org, entity, { asOfDate: date, knownAt: instant, limit: 100 })).data.find(row => row.id === target)!;
const requireClear = (journal: string, date = "2026-12-31") => internal(client => client.query("SELECT app_security.require_journal_dependencies_clear($1,$2,$3,$4)", [org, entity, journal, date]));
const hold = (journal: string, dependency: string = randomUUID(), type = "close") => internal(client => client.query("INSERT INTO journal_reversal_holds VALUES($1,$2,$3,$4,$5,'Synthetic controlled dependency')", [org, entity, journal, type, dependency]));
async function allocationId(source: string) { return (await admin.query("SELECT id FROM subledger_allocations WHERE source_id=$1", [source])).rows[0].id as string; }
const inverse = (allocation: string, date = "2026-03-01"): SubledgerSourceValue => ({ kind: "allocation_reverse", reversalOf: allocation, postingDate: date, documentDate: date, reason: "Synthetic controlled inverse" });

beforeAll(async () => {
  const url = new URL(process.env.MIGRATION_DATABASE_URL ?? "");
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/kaamledger") throw new Error("Subledger fixtures require the dedicated local database.");
  for (const id of users) await admin.query("INSERT INTO auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Subledger test',$2,true,now(),now())", [id, `${id}@example.invalid`]);
  await admin.query("INSERT INTO organizations(id,name) VALUES($1,'Subledger fixture')", [org]);
  for (const id of [entity, other]) await admin.query("INSERT INTO legal_entities(id,organization_id,name,active_modes,reporting_profile,created_by) VALUES($1,$2,'Subledger company','[\"labour\"]','demo_accrual',$3)", [id, org, finance]);
  for (const [id, role] of [[finance, "finance_manager"], [reader, "auditor"]]) await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,$4,$5,'[]')", [randomUUID(), org, id, JSON.stringify([role]), JSON.stringify([entity])]);
  for (const [code, type, control] of [["ar", "asset", "ar"], ["ap", "liability", "ap"], ["cash", "asset", "cash"], ["customer_deposits", "liability", "customer_deposits"], ["supplier_advances", "asset", "supplier_advances"], ["revenue", "revenue", null], ["expense", "expense", null], ["capital", "equity", null]] as const) {
    const account = await createAccount(finance, org, entity, { code, name: code, type, normalSide: type === "asset" || type === "expense" ? "debit" : "credit", isControl: control !== null, controlType: control, reportMapping: { statementSection: type === "asset" ? "assets" : type === "liability" ? "liabilities" : type === "equity" ? "equity" : type === "revenue" ? "revenue" : "expenses", cashFlowCategory: control === "cash" ? "cash" : "unclassified" } }, randomUUID(), randomUUID()); accounts[code] = account.id;
  }
  await createFiscalYear(finance, org, entity, { fiscalYearLabel: "Subledger synthetic year", retainedEarningsAccountId: accounts.capital, periods: [{ startDate: "2026-01-01", endDateExclusive: "2027-01-01" }] }, randomUUID(), randomUUID());
  await internal(async client => { for (const id of [party, otherParty]) await client.query("INSERT INTO subledger_counterparties VALUES($1,$2,$3,$4)", [org, entity, id, finance]); });
});
afterAll(async () => {
  const url = new URL(process.env.MIGRATION_DATABASE_URL ?? ""); if (url.hostname !== "127.0.0.1" || url.pathname !== "/kaamledger") return;
  const client = await admin.connect();
  const triggers = [...["journal_reversal_hold_releases", "subledger_events", "subledger_allocations", "subledger_open_items", "subledger_settlements", "subledger_sources", "subledger_counterparties"].map(table => [table, "subledger_immutable"]), ["journal_reversal_holds", "reversal_immutable"], ["journal_lines", "journal_line_immutable"], ["journal_entries", "journal_entry_immutable"], ["document_numbers", "document_number_immutable"], ["document_series", "document_series_no_delete"], ["fiscal_periods", "fiscal_period_immutable"], ["fiscal_years", "fiscal_year_immutable"], ["account_versions", "account_version_append_only"], ["accounts", "account_no_delete"], ["audit_events", "audit_append_only"]];
  try {
    await client.query("BEGIN"); for (const [table, trigger] of triggers) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    for (const table of ["journal_reversal_hold_releases", "journal_reversal_holds", "subledger_events", "subledger_allocations", "subledger_open_items", "subledger_settlements", "subledger_sources", "subledger_counterparties", "journal_lines", "journal_entries", "document_numbers", "document_series", "fiscal_periods", "fiscal_years", "account_versions", "accounts", "audit_events", "idempotency_results", "memberships", "legal_entities"]) await client.query(`DELETE FROM ${table} WHERE organization_id=$1`, [org]);
    await client.query("DELETE FROM organizations WHERE id=$1", [org]); await client.query("DELETE FROM auth_user WHERE id=ANY($1::text[])", [users]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    for (const [table, trigger] of triggers) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`); await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); await admin.end(); await databasePool().end(); }
});

it("persists real AR/deposit journals, reclassifies once and reconstructs both cut-offs without netting", async () => {
  const p = await pair(), command = randomUUID(), journal = await post(apply(p.settlement, p.target), command);
  expect(await balance(p.target, "2026-01-31")).toMatchObject({ originalAmount: "3000.00", allocatedAmount: "0.00", outstandingAmount: "3000.00" });
  expect(await balance(p.target, "2026-02-01")).toMatchObject({ allocatedAmount: "3000.00", outstandingAmount: "0.00" });
  const watermark = (await admin.query("SELECT to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS exact,to_char((recorded_at-interval '1 microsecond') AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS earlier FROM subledger_sources WHERE id=$1", [command])).rows[0];
  expect((await balance(p.target, "2026-02-01", watermark.earlier)).outstandingAmount).toBe("3000.00");
  expect((await balance(p.target, "2026-02-01", watermark.exact)).outstandingAmount).toBe("0.00");
  const totals = await admin.query("SELECT a.control_type,sum(l.debit-l.credit)::text AS net FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE l.journal_id IN (SELECT journal_id FROM subledger_sources WHERE id=ANY($1::uuid[])) GROUP BY a.control_type", [[p.itemSource, p.settlement, command]]);
  expect(totals.rows).toEqual(expect.arrayContaining([{ control_type: "ar", net: "0.00" }, { control_type: "customer_deposits", net: "-2000.00" }, { control_type: "cash", net: "5000.00" }]));
  expect((await admin.query("SELECT total_debit::text AS debit,total_credit::text AS credit FROM journal_entries WHERE id=$1", [journal])).rows).toEqual([{ debit: "3000.00", credit: "3000.00" }]);
  const ledger = await readGeneralLedger(reader, org, entity, { accountId: accounts.ar, fromDate: "2026-01-01", toDateExclusive: "2026-02-02" });
  expect(ledger.totals).toMatchObject({ periodDebit: "3000.00", periodCredit: "3000.00", closingBalance: "0.00", lineCount: "2" });
  expect(ledger.rows.map(row => row.source.type)).toEqual(["invoice", "settlement"]);
  expect(ledger.rows.map(row => row.runningBalance)).toEqual(["3000.00", "0.00"]);
  expect(ledger.rows.every(row => row.manualJournalId === null)).toBe(true);
  const statement = await readStatementFoundation(reader, org, entity, { fromDate: "2026-01-01", toDateExclusive: "2026-02-02", knownAt: ledger.metadata.knownAt });
  expect(statement.trialBalance.totals.closing).toEqual({ debit: "5000.00", credit: "5000.00" });
  expect(statement.balanceSheet).toMatchObject({ assets: "5000.00", liabilities: "2000.00", currentYearResult: "3000.00", equity: "3000.00", difference: "0.00" });
});
it("AP advance application follows the independent payable direction", async () => {
  const p = await pair("ap"); const journal = await post(apply(p.settlement, p.target, "1000.01"));
  expect((await balance(p.target)).outstandingAmount).toBe("1999.99");
  expect((await admin.query("SELECT a.control_type,l.debit::text,l.credit::text FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE journal_id=$1 ORDER BY ordinal", [journal])).rows).toEqual([{ control_type: "ap", debit: "1000.01", credit: "0.00" }, { control_type: "supplier_advances", debit: "0.00", credit: "1000.01" }]);
});
it("duplicate source races return one journal, number, event, source receipt and audit", async () => {
  const source = randomUUID(), input = item(); const [a, b] = await Promise.all([post(input, source), post(input, source)]); expect(a).toBe(b);
  expect(await post(input, source)).toBe(a);
  for (const [table, column] of [["journal_entries", "source_id"], ["subledger_sources", "id"], ["subledger_events", "source_id"], ["document_numbers", "source_id"], ["audit_events", "target_id"]]) expect((await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`, [source])).rows[0].n).toBe(1);
  await expect(post({ ...input, amount: "3000.01" } as SubledgerSourceValue, source)).rejects.toMatchObject({ message: "SOURCE_CONFLICT" });
});
it("racing independent allocations cannot exceed one target or source", async () => {
  const p = await pair(); const results = await Promise.allSettled([post(apply(p.settlement, p.target, "2000.00")), post(apply(p.settlement, p.target, "2000.00"))]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1); expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { message: "OVER_ALLOCATION" } });
  expect((await balance(p.target)).outstandingAmount).toBe("1000.00");
  const sourceRace = await pair("ar", "6000.00", "3000.00"); const input = apply(sourceRace.settlement, sourceRace.target, "2000.00");
  const secondRace = await Promise.allSettled([post(input), post(input)]); expect(secondRace.filter(result => result.status === "fulfilled")).toHaveLength(1);
});
it("dated allocation inverse preserves originals, retained versions and immutable hold releases", async () => {
  const p = await pair(), application = randomUUID(); const journal = await post(apply(p.settlement, p.target), application);
  const original = (await admin.query("SELECT * FROM subledger_allocations WHERE source_id=$1", [application])).rows[0];
  const before = (await admin.query("SELECT * FROM journal_entries WHERE id=$1", [journal])).rows[0];
  const master = (await admin.query("SELECT version FROM accounts WHERE id=$1", [accounts.ar])).rows[0];
  await patchAccount(finance, org, entity, accounts.ar, { name: "Renamed AR" }, master.version, randomUUID());
  const reverse = randomUUID(), body: SubledgerSourceValue = { kind: "allocation_reverse", reversalOf: original.id, postingDate: "2026-03-01", documentDate: "2026-03-01", reason: "Correct fictional allocation" };
  const inverse = await post(body, reverse); expect(await post(body, reverse)).toBe(inverse);
  expect((await balance(p.target, "2026-02-28")).outstandingAmount).toBe("0.00"); expect((await balance(p.target, "2026-03-01")).outstandingAmount).toBe("3000.00");
  expect((await admin.query("SELECT * FROM journal_entries WHERE id=$1", [journal])).rows[0]).toEqual(before); expect((await admin.query("SELECT * FROM subledger_allocations WHERE id=$1", [original.id])).rows[0]).toEqual(original);
  expect((await admin.query("SELECT count(*)::int AS n FROM journal_reversal_hold_releases WHERE dependency_id=$1", [original.id])).rows[0].n).toBe(3);
  expect((await admin.query("SELECT count(*)::int AS n FROM journal_reversal_holds WHERE dependency_id=$1", [original.id])).rows[0].n).toBe(3);
  const versions = await admin.query("SELECT account_version FROM journal_lines WHERE journal_id=$1 AND account_id=$2", [inverse, accounts.ar]); expect(versions.rows[0].account_version).toBe(master.version);
  await expect(post(body)).rejects.toMatchObject({ message: "ALREADY_REVERSED" });
  const reversedEvent = (await admin.query("SELECT id FROM subledger_allocations WHERE source_id=$1", [reverse])).rows[0].id;
  await expect(post({ ...body, reversalOf: reversedEvent })).rejects.toMatchObject({ message: "INVALID_STATE" });
});
it("direct settlements allocate their full original control line and cannot be applied again", async () => {
  const source = randomUUID(); await post(item(), source); const target = (await admin.query("SELECT id FROM subledger_open_items WHERE source_id=$1", [source])).rows[0].id;
  const direct = randomUUID(), body: SubledgerSourceValue = { kind: "ar_direct", postingDate: "2026-02-01", documentDate: "2026-02-01", partyId: party, amount: "3000.00", controlAccountId: accounts.ar, counterAccountId: accounts.cash, allocations: [{ openItemId: target, amount: "3000.00" }] };
  await post(body, direct); expect((await balance(target)).outstandingAmount).toBe("0.00");
  await expect(post(apply(direct, target, "1.00"))).rejects.toMatchObject({ message: "SOURCE_ALREADY_CONSUMED" });
  await expect(post({ ...body, amount: "3000.01" } as SubledgerSourceValue)).rejects.toMatchObject({ message: "DIRECT_SETTLEMENT_INCOMPLETE" });
});
it("rejects cross-party, cross-side, wrong control account and guessed entity references", async () => {
  const p = await pair(), wrongParty = randomUUID(); await post(deposit("ar", "5000.00", otherParty), wrongParty);
  await expect(post(apply(wrongParty, p.target))).rejects.toMatchObject({ message: "SUBLEDGER_SCOPE_MISMATCH" });
  const payable = await pair("ap"); await expect(post(apply(p.settlement, payable.target))).rejects.toMatchObject({ message: "SUBLEDGER_SCOPE_MISMATCH" });
  await expect(post({ ...item(), controlAccountId: accounts.cash } as SubledgerSourceValue)).rejects.toMatchObject({ message: "ACCOUNT_UNAVAILABLE" });
  await expect(readOpenBalances(reader, org, other, { asOfDate: "2026-12-31", knownAt })).rejects.toMatchObject({ status: 404 });
  expect(await withScope(reader, org, entity, "journals.read", async client => (await client.query("SELECT * FROM subledger_open_items WHERE legal_entity_id=$1", [other])).rows)).toEqual([]);
});
it("runtime cannot create sources, alter histories, release private holds or execute the producer", async () => {
  for (const table of ["subledger_counterparties", "subledger_sources", "subledger_open_items", "subledger_settlements", "subledger_allocations", "subledger_events"]) {
    expect((await databasePool().query(`SELECT * FROM ${table}`)).rows).toEqual([]);
    await expect(withScope(finance, org, entity, "journals.read", client => client.query(`DELETE FROM ${table}`))).rejects.toMatchObject({ code: "42501" });
    await expect(withScope(finance, org, entity, "journals.read", client => client.query(`UPDATE ${table} SET organization_id=organization_id`))).rejects.toMatchObject({ code: "42501" });
    await expect(withScope(finance, org, entity, "journals.read", client => client.query(`INSERT INTO ${table} SELECT * FROM ${table} WHERE false`))).rejects.toMatchObject({ code: "42501" });
  }
  await expect(withScope(finance, org, entity, "journals.read", client => writeSubledgerSource(client, org, entity, randomUUID(), item(), randomUUID()))).rejects.toMatchObject({ code: "42501" });
  await expect(databasePool().query("SELECT * FROM journal_reversal_hold_releases")).rejects.toMatchObject({ code: "42501" });
  await expect(internal(client => client.query("UPDATE subledger_open_items SET amount=amount WHERE organization_id=$1", [org]))).rejects.toMatchObject({ message: "Audit history is append-only" });
  await admin.query("UPDATE memberships SET active=false WHERE user_id=$1", [reader]);
  await expect(readOpenBalances(reader, org, entity, { asOfDate: "2026-12-31", knownAt })).rejects.toMatchObject({ status: 404 });
  await admin.query("UPDATE memberships SET active=true WHERE user_id=$1", [reader]);
});
it("denies late ledger lines, late source children and unauthenticated producer replay", async () => {
  const source = randomUUID(), journal = await post(item(), source);
  await expect(internal(client => client.query("INSERT INTO journal_lines(organization_id,legal_entity_id,journal_id,ordinal,account_id,account_version,debit,credit) SELECT organization_id,legal_entity_id,journal_id,3,account_id,account_version,debit,credit FROM journal_lines WHERE journal_id=$1 AND ordinal=1", [journal]))).rejects.toMatchObject({ message: "Posted journal cannot acquire new lines" });
  await expect(internal(client => client.query("INSERT INTO subledger_events SELECT * FROM subledger_events WHERE source_id=$1", [source]))).rejects.toMatchObject({ message: "SUBLEDGER_LINK_MISMATCH" });
  await admin.query("UPDATE memberships SET active=false WHERE user_id=$1", [finance]);
  try { await expect(post(item(), source)).rejects.toMatchObject({ message: "FORBIDDEN" }); }
  finally { await admin.query("UPDATE memberships SET active=true WHERE user_id=$1", [finance]); }
  expect(await post(item(), source)).toBe(journal);
});
it("requires a reserved scoped counterparty and denies retroactive hold releases", async () => {
  await expect(post(item("ar", "0.01", randomUUID()))).rejects.toMatchObject({ code: "23503" });
  const p = await pair(), application = randomUUID(); await post(apply(p.settlement, p.target), application);
  const allocation = (await admin.query("SELECT id FROM subledger_allocations WHERE source_id=$1", [application])).rows[0].id;
  await expect(internal(client => client.query("INSERT INTO journal_reversal_hold_releases SELECT organization_id,legal_entity_id,journal_id,dependency_type,dependency_id,$2 FROM journal_reversal_holds WHERE dependency_id=$1 LIMIT 1", [allocation, application]))).rejects.toMatchObject({ message: "SUBLEDGER_LINK_MISMATCH" });
  await post({ kind: "allocation_reverse", reversalOf: allocation, postingDate: "2026-03-01", documentDate: "2026-03-01", reason: "Fixture inverse" });
  await expect(internal(client => client.query("DELETE FROM journal_reversal_hold_releases WHERE dependency_id=$1", [allocation]))).rejects.toMatchObject({ message: "Audit history is append-only" });
});

// Simulate a producer omitting a mandatory effect without disabling any guard.
async function suppressEffect(table: string, predicate: string, work: () => Promise<void>) {
  const client = await admin.connect(), trigger = `subledger_fault_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("CREATE OR REPLACE FUNCTION pg_temp.suppress_subledger_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$");
    await client.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} FOR EACH ROW WHEN (${predicate}) EXECUTE FUNCTION pg_temp.suppress_subledger_fixture()`);
    try { await work(); } finally { await client.query(`DROP TRIGGER ${trigger} ON ${table}`); }
  } finally { client.release(); }
}
it.each(["subledger_open_items", "subledger_events"])("deferred source completeness rejects a missing %s and rolls back every receipt", async table => {
  const source = randomUUID();
  await suppressEffect(table, `NEW.source_id='${source}'::uuid`, async () => {
    await expect(post(item(), source)).rejects.toMatchObject({ message: "SUBLEDGER_LINK_MISMATCH" });
  });
  for (const [table, column] of [["subledger_sources", "id"], ["journal_entries", "source_id"], ["document_numbers", "source_id"], ["audit_events", "target_id"]])
    expect((await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`, [source])).rows[0].n).toBe(0);
});
it("missing dependency holds or inverse releases fail atomically, preserving the active balance", async () => {
  const p = await pair(), source = randomUUID();
  const originalJournal = (await admin.query("SELECT journal_id FROM subledger_open_items WHERE id=$1", [p.target])).rows[0].journal_id;
  await suppressEffect("journal_reversal_holds", `NEW.journal_id='${originalJournal}'::uuid`, async () => {
    await expect(post(apply(p.settlement, p.target), source)).rejects.toMatchObject({ message: "SUBLEDGER_DEPENDENCY_MISSING" });
  });
  expect((await balance(p.target)).outstandingAmount).toBe("3000.00");
  await post(apply(p.settlement, p.target), source);
  const allocation = (await admin.query("SELECT id FROM subledger_allocations WHERE source_id=$1", [source])).rows[0].id;
  const inverseSource = randomUUID();
  await suppressEffect("journal_reversal_hold_releases", `NEW.release_source_id='${inverseSource}'::uuid AND NEW.journal_id='${originalJournal}'::uuid`, async () => {
    await expect(post({ kind: "allocation_reverse", reversalOf: allocation, postingDate: "2026-03-01", documentDate: "2026-03-01", reason: "Fixture inverse" }, inverseSource)).rejects.toMatchObject({ message: "SUBLEDGER_DEPENDENCY_MISSING" });
  });
  expect((await balance(p.target)).outstandingAmount).toBe("0.00");
  expect((await admin.query("SELECT count(*)::int AS n FROM journal_reversal_hold_releases WHERE dependency_id=$1", [allocation])).rows[0].n).toBe(0);
  expect((await admin.query("SELECT count(*)::int AS n FROM subledger_sources WHERE id=$1", [inverseSource])).rows[0].n).toBe(0);
});
it("rolls source, ledger, number, event, allocation and holds back when audit insertion fails", async () => {
  const p = await pair(), source = randomUUID(), constraint = `subledger_fault_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`ALTER TABLE audit_events ADD CONSTRAINT ${constraint} CHECK(target_id<>'${source}'::uuid) NOT VALID`);
  const before = (await admin.query("SELECT next_number FROM document_series WHERE legal_entity_id=$1 AND document_type='settlement'", [entity])).rows;
  try { await expect(post(apply(p.settlement, p.target), source)).rejects.toMatchObject({ code: "23514" }); } finally { await admin.query(`ALTER TABLE audit_events DROP CONSTRAINT ${constraint}`); }
  for (const [table, column] of [["subledger_sources", "id"], ["journal_entries", "source_id"], ["document_numbers", "source_id"], ["subledger_events", "source_id"], ["subledger_allocations", "source_id"]]) expect((await admin.query(`SELECT * FROM ${table} WHERE ${column}=$1`, [source])).rowCount).toBe(0);
  expect((await admin.query("SELECT next_number FROM document_series WHERE legal_entity_id=$1 AND document_type='settlement'", [entity])).rows).toEqual(before);
  expect((await balance(p.target)).outstandingAmount).toBe("3000.00");
});
it("a backdated allocation cannot borrow from an application reversed only at a later business date", async () => {
  const p = await pair(), source = randomUUID(); await post(apply(p.settlement, p.target, "3000.00", "2026-02-03"), source);
  const allocation = (await admin.query("SELECT id FROM subledger_allocations WHERE source_id=$1", [source])).rows[0].id;
  await post({ kind: "allocation_reverse", reversalOf: allocation, postingDate: "2026-02-05", documentDate: "2026-02-05", reason: "Fictional later reversal" });
  await expect(post(apply(p.settlement, p.target, "3000.00", "2026-02-04"))).rejects.toMatchObject({ message: "OVER_ALLOCATION" });
  await post(apply(p.settlement, p.target, "3000.00", "2026-02-06")); expect((await balance(p.target)).outstandingAmount).toBe("0.00");
});
it("bounded keyset pages have exact string values and stable nonoverlapping cursors", async () => {
  const first = await readOpenBalances(reader, org, entity, { asOfDate: "2026-12-31", knownAt, limit: 2 }); expect(first.data).toHaveLength(2); expect(first.nextCursor).toBe(first.data[1].id);
  const second = await readOpenBalances(reader, org, entity, { asOfDate: "2026-12-31", knownAt, limit: 2, after: first.nextCursor! }); expect(second.data).toHaveLength(2); expect(second.data.some(row => first.data.some(previous => previous.id === row.id))).toBe(false);
  expect(first.data.every(row => typeof row.outstandingAmount === "string")).toBe(true);
});
it("dependency clearing recognizes only dated releases and keeps all original evidence", async () => {
  const p = await pair(), one = randomUUID(), two = randomUUID();
  const firstJournal = await post(apply(p.settlement, p.target, "1000.00"), one);
  await post(apply(p.settlement, p.target, "1000.00"), two);
  const targetJournal = (await admin.query("SELECT journal_id FROM subledger_open_items WHERE id=$1", [p.target])).rows[0].journal_id;
  await expect(requireClear(targetJournal)).rejects.toMatchObject({ message: "REVERSAL_DEPENDENCY" });
  await post(inverse(await allocationId(one)));
  await expect(requireClear(targetJournal)).rejects.toMatchObject({ message: "REVERSAL_DEPENDENCY" });
  await requireClear(firstJournal, "2026-03-01");
  await expect(requireClear(firstJournal, "2026-02-28")).rejects.toMatchObject({ message: "REVERSAL_DEPENDENCY" });
  await post(inverse(await allocationId(two), "2026-03-02"));
  await requireClear(targetJournal, "2026-03-02");
  await expect(requireClear(targetJournal, "2026-03-01")).rejects.toMatchObject({ message: "REVERSAL_DEPENDENCY" });
  expect((await admin.query("SELECT count(*)::int AS n FROM journal_reversal_holds WHERE journal_id=$1", [targetJournal])).rows[0].n).toBe(2);
  expect((await admin.query("SELECT count(*)::int AS n FROM journal_reversal_hold_releases WHERE journal_id=$1", [targetJournal])).rows[0].n).toBe(2);
});
it.each(["payment", "reconciliation", "close"])("an unrelated %s dependency blocks inverse commit, including a colliding allocation ID", async type => {
  const p = await pair(), source = randomUUID(), journal = await post(apply(p.settlement, p.target), source), allocation = await allocationId(source);
  await hold(journal, allocation, type); const failedSource = randomUUID();
  await expect(post(inverse(allocation), failedSource)).rejects.toMatchObject({ message: "REVERSAL_DEPENDENCY" });
  expect((await admin.query("SELECT count(*)::int AS n FROM subledger_sources WHERE id=$1", [failedSource])).rows[0].n).toBe(0);
  expect((await admin.query("SELECT count(*)::int AS n FROM journal_reversal_hold_releases WHERE dependency_id=$1", [allocation])).rows[0].n).toBe(0);
  expect((await balance(p.target)).outstandingAmount).toBe("0.00");
});
it("same-transaction and later holds cannot attach after inverse creation", async () => {
  const p = await pair(), source = randomUUID(), journal = await post(apply(p.settlement, p.target), source), allocation = await allocationId(source), failedSource = randomUUID();
  await expect(internal(async client => {
    await writeSubledgerSource(client, org, entity, failedSource, inverse(allocation), randomUUID());
    // The original now has an inverse row, so the hold guard denies this order.
    await client.query("INSERT INTO journal_reversal_holds VALUES($1,$2,$3,'close',$4,'Synthetic late dependency')", [org, entity, journal, randomUUID()]);
  })).rejects.toMatchObject({ message: "ALREADY_REVERSED" });
  expect((await admin.query("SELECT count(*)::int AS n FROM subledger_sources WHERE id=$1", [failedSource])).rows[0].n).toBe(0);
  await post(inverse(allocation)); await expect(hold(journal)).rejects.toMatchObject({ message: "ALREADY_REVERSED" });
});
it("racing dependency and inverse commits cannot both succeed", async () => {
  const p = await pair(), source = randomUUID(), journal = await post(apply(p.settlement, p.target), source), allocation = await allocationId(source);
  const results = await Promise.allSettled([post(inverse(allocation)), hold(journal)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const reason = results.find(result => result.status === "rejected") as PromiseRejectedResult;
  expect(["ALREADY_REVERSED", "REVERSAL_DEPENDENCY"]).toContain(reason.reason.message);
});
it("the common gate remains private, scoped and revocation-sensitive", async () => {
  const source = randomUUID(), journal = await post(item(), source); await requireClear(journal);
  await expect(withScope(finance, org, entity, "journals.read", client => client.query("SELECT app_security.require_journal_dependencies_clear($1,$2,$3,$4)", [org, entity, journal, "2026-12-31"]))).rejects.toMatchObject({ code: "42501" });
  await expect(requireClear(randomUUID())).rejects.toMatchObject({ message: "NOT_FOUND" });
  await expect(internal(client => client.query("SELECT app_security.require_journal_dependencies_clear($1,$2,$3,$4)", [org, other, journal, "2026-12-31"]))).rejects.toMatchObject({ message: "FORBIDDEN" });
  await expect(requireClear(journal, "1899-12-31")).rejects.toMatchObject({ message: "INVALID_CONTENT" });
  await admin.query("UPDATE memberships SET active=false WHERE user_id=$1", [finance]);
  try { await expect(requireClear(journal)).rejects.toMatchObject({ message: "FORBIDDEN" }); }
  finally { await admin.query("UPDATE memberships SET active=true WHERE user_id=$1", [finance]); }
});
it("the window checker agrees with independent rectangle sums before rejecting an invalid backdated commit", async () => {
  const p = await pair(), original = randomUUID(); await post(apply(p.settlement, p.target, "3000.00", "2026-02-03"), original);
  await post(inverse(await allocationId(original), "2026-02-05"));
  async function compare(client: PoolClient, expected: boolean) {
    const result = await client.query(`WITH e AS (
      SELECT 'target' AS book,effective_date,recorded_at,CASE WHEN reversal_of IS NULL THEN amount ELSE -amount END AS amount,3000::numeric AS maximum FROM subledger_allocations WHERE organization_id=$1 AND legal_entity_id=$2 AND open_item_id=$3
      UNION ALL SELECT 'capacity',effective_date,recorded_at,CASE WHEN reversal_of IS NULL THEN amount ELSE -amount END,5000::numeric FROM subledger_allocations WHERE organization_id=$1 AND legal_entity_id=$2 AND settlement_id=$4
    ), d AS (SELECT DISTINCT book,effective_date FROM e), k AS (SELECT DISTINCT book,recorded_at FROM e)
    SELECT app_security.allocation_rectangles_within_limits($1,$2,$3,$4,3000,5000) AS optimized, NOT EXISTS(
      SELECT 1 FROM d JOIN k ON k.book=d.book JOIN e ON e.book=d.book AND e.effective_date<=d.effective_date AND e.recorded_at<=k.recorded_at
      GROUP BY d.book,d.effective_date,k.recorded_at HAVING sum(e.amount)<0 OR sum(e.amount)>max(e.maximum)
    ) AS reference`, [org, entity, p.target, p.settlement]);
    expect(result.rows).toEqual([{ optimized: expected, reference: expected }]);
  }
  await internal(client => compare(client, true));
  const invalid = randomUUID();
  await expect(internal(async client => {
    await writeSubledgerSource(client, org, entity, invalid, apply(p.settlement, p.target, "3000.00", "2026-02-04"), randomUUID());
    await compare(client, false);
  })).rejects.toMatchObject({ message: "OVER_ALLOCATION" });
  expect((await admin.query("SELECT count(*)::int AS n FROM subledger_sources WHERE id=$1", [invalid])).rows[0].n).toBe(0);
  await post(apply(p.settlement, p.target, "3000.00", "2026-02-06")); await internal(client => compare(client, true));
  await expect(withScope(finance, org, entity, "journals.read", client => client.query("SELECT app_security.allocation_rectangles_within_limits($1,$2,$3,$4,3000,5000)", [org, entity, p.target, p.settlement]))).rejects.toMatchObject({ code: "42501" });
});
