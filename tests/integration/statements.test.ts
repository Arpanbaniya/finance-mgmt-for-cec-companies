import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { beforeAll, afterAll, expect, it } from "vitest";
import { databasePool } from "@/db/client";
import { withScope } from "@/features/identity/scope";
import { createAccount, patchAccount } from "@/features/accounting/accounts-service";
import { createFiscalYear } from "@/features/accounting/setup-service";
import { writeManualJournal } from "@/features/accounting/posting-kernel";
import { readStatementFoundation } from "@/features/reporting/statement-service";
import { readGeneralLedger } from "@/features/reporting/general-ledger-service";
import { decodeLedgerCursor, encodeLedgerCursor } from "@/features/reporting/ledger-cursor";
import { LedgerQuery } from "@/domain/general-ledger";

config({ path: ".env.local", quiet: true });
const org = randomUUID(), entity = randomUUID(), other = randomUUID();
const actors = Object.fromEntries(["finance_manager", "accountant", "auditor", "owner", "organization_admin", "site_supervisor"].map(role => [role, `statement-${randomUUID()}`]));
const finance = actors.finance_manager, reader = actors.auditor;
const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const accounts: Record<string, string> = {};
const interval = { fromDate: "2026-01-01", toDateExclusive: "2027-01-01" };
// The existing GitHub workflow exposes its isolated PostgreSQL container at
// 5432. Desktop fixtures use 55432; neither path may use a hosted database.
const fixturePort = process.env.GITHUB_ACTIONS === "true" ? "5432" : "55432";
let initialCutoff = "", initialJournal = "";
async function internal<T>(work: (client: PoolClient) => Promise<T>, company = entity) {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id',$1,true),set_config('app.org_id',$2,true),set_config('app.entity_id',$3,true)", [finance, org, company]);
    const result = await work(client); await client.query("COMMIT"); return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
const post = (date: string, lines: { accountId: string; accountVersion?: number; debit: string; credit: string }[]) => internal(client => writeManualJournal(client, org, entity, randomUUID(), {
  postingDate: date, documentDate: date, description: "Independent ordinary-account statement fixture", currency: "NPR", lines: lines.map(line => ({ accountVersion: 1, dimensions: {}, ...line })),
}, randomUUID()));
const read = (query: unknown = { ...interval, knownAt: initialCutoff }, actor = reader, company = entity) => readStatementFoundation(actor, org, company, query);

beforeAll(async () => {
  for (const name of ["MIGRATION_DATABASE_URL", "DATABASE_URL"]) {
    const url = new URL(process.env[name] ?? "");
    if (url.hostname !== "127.0.0.1" || url.port !== fixturePort || url.pathname !== "/kaamledger") throw new Error("Statement fixtures require the dedicated local database.");
  }
  for (const id of Object.values(actors)) await admin.query("INSERT INTO auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Statement fixture',$2,true,now(),now())", [id, `${id}@example.invalid`]);
  await admin.query("INSERT INTO organizations(id,name) VALUES($1,'Independent statement fixture')", [org]);
  for (const id of [entity, other]) await admin.query("INSERT INTO legal_entities(id,organization_id,name,active_modes,reporting_profile,created_by) VALUES($1,$2,'Statement company','[\"labour\"]','demo_accrual',$3)", [id, org, finance]);
  for (const [role, id] of Object.entries(actors)) await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,$4,$5,'[]')", [randomUUID(), org, id, JSON.stringify([role]), JSON.stringify(role === "finance_manager" ? [entity, other] : [entity])]);
  for (const [code, type] of [["BANK", "asset"], ["AR", "asset"], ["WITHHOLDING", "asset"], ["WAGES", "expense"], ["EMPLOYER", "expense"], ["CAPITAL", "equity"], ["REVENUE", "revenue"], ["OUTPUT-TAX", "liability"], ["STATUTORY", "liability"]] as const) {
    const account = await createAccount(finance, org, entity, { code, name: code, type, normalSide: type === "asset" || type === "expense" ? "debit" : "credit", isControl: false, controlType: null,
      reportMapping: { statementSection: type === "asset" ? "assets" : type === "liability" ? "liabilities" : type === "equity" ? "equity" : type === "revenue" ? "revenue" : "expenses", cashFlowCategory: "unclassified" } }, randomUUID(), randomUUID()); accounts[code] = account.id;
  }
  const otherCapital = await createAccount(finance, org, other, { code: "CAPITAL", name: "Other capital", type: "equity", normalSide: "credit", isControl: false, controlType: null,
    reportMapping: { statementSection: "equity", cashFlowCategory: "unclassified" } }, randomUUID(), randomUUID());
  for (const [company, start, end, retained] of [[entity, "2025-01-01", "2026-01-01", accounts.CAPITAL], [entity, "2026-01-01", "2027-01-01", accounts.CAPITAL], [other, "2026-01-01", "2027-01-01", otherCapital.id]]) {
    await createFiscalYear(finance, org, company, { fiscalYearLabel: `Synthetic ${start}`, retainedEarningsAccountId: retained, periods: [{ startDate: start, endDateExclusive: end }] }, randomUUID(), randomUUID());
  }
  // Numeric fixture A balances in one ordinary journal. This is NOT a seed of
  // payroll, invoices, cash controls or opening-import workflows.
  const receipt = await post("2026-02-01", [["BANK", "98500.00", "0.00"], ["AR", "15300.00", "0.00"], ["WITHHOLDING", "1000.00", "0.00"],
    ["WAGES", "22000.00", "0.00"], ["EMPLOYER", "700.00", "0.00"], ["CAPITAL", "0.00", "100000.00"], ["REVENUE", "0.00", "33000.00"], ["OUTPUT-TAX", "0.00", "3300.00"], ["STATUTORY", "0.00", "1200.00"]]
    .map(([code, debit, credit]) => ({ accountId: accounts[code], debit, credit })));
  initialJournal = receipt.id;
  initialCutoff = (await readStatementFoundation(reader, org, entity, interval)).metadata.knownAt;
});
afterAll(async () => {
  const url = new URL(process.env.MIGRATION_DATABASE_URL ?? "");
  if (url.hostname !== "127.0.0.1" || url.port !== fixturePort || url.pathname !== "/kaamledger") return;
  const client = await admin.connect();
  const triggers = [["journal_lines", "journal_line_immutable"], ["journal_entries", "journal_entry_immutable"], ["document_numbers", "document_number_immutable"], ["document_series", "document_series_no_delete"], ["fiscal_periods", "fiscal_period_immutable"], ["fiscal_years", "fiscal_year_immutable"], ["account_versions", "account_version_append_only"], ["accounts", "account_no_delete"], ["audit_events", "audit_append_only"]];
  try {
    await client.query("BEGIN"); for (const [table, trigger] of triggers) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    for (const table of ["journal_lines", "journal_entries", "document_numbers", "document_series", "fiscal_periods", "fiscal_years", "account_versions", "accounts", "audit_events", "idempotency_results", "memberships", "legal_entities"]) await client.query(`DELETE FROM ${table} WHERE organization_id=$1`, [org]);
    await client.query("DELETE FROM organizations WHERE id=$1", [org]); await client.query("DELETE FROM auth_user WHERE id=ANY($1::text[])", [Object.values(actors)]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    for (const [table, trigger] of triggers) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`); await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); await admin.end(); await databasePool().end(); }
});

it("ties real posted aggregates to independently specified TB, income and balance-sheet totals", async () => {
  const report = await read();
  expect(report.trialBalance.rows).toHaveLength(9);
  expect(report.trialBalance.totals.closing).toEqual({ debit: "137500.00", credit: "137500.00" });
  expect(report.incomeMovement).toEqual({ revenue: "33000.00", expenses: "22700.00", result: "10300.00" });
  expect(report.balanceSheet).toEqual({ assets: "114800.00", liabilities: "4500.00", postedEquity: "100000.00", currentYearResult: "10300.00", priorUnclosedResult: "0.00", equity: "110300.00", difference: "0.00" });
  expect(report.metadata).toMatchObject({ organizationId: org, entityId: entity, currency: "NPR", journalCount: "1", asOfDate: "2026-12-31", fiscalYearStart: "2026-01-01", knownAt: initialCutoff, mappingBasis: "posted-account-versions" });
  expect(report.metadata.ledgerWatermark).toMatch(/\.\d{6}Z$/);
});
it("uses exclusive business-date bounds and carries opening balances independently of period income", async () => {
  expect((await read({ fromDate: "2026-01-01", toDateExclusive: "2026-02-01", knownAt: initialCutoff })).metadata.journalCount).toBe("0");
  const report = await read({ fromDate: "2026-03-01", toDateExclusive: "2027-01-01", knownAt: initialCutoff });
  expect(report.trialBalance.totals.opening).toEqual({ debit: "137500.00", credit: "137500.00" });
  expect(report.trialBalance.totals.movement).toEqual({ debit: "0.00", credit: "0.00" });
  expect(report.incomeMovement.result).toBe("0.00"); expect(report.balanceSheet.currentYearResult).toBe("10300.00");
});
it("allows actual finance readers but does not grant owner/admin/site users raw-ledger reporting", async () => {
  for (const actor of [actors.accountant, finance]) expect((await read(undefined, actor)).balanceSheet.assets).toBe("114800.00");
  for (const actor of [actors.owner, actors.organization_admin, actors.site_supervisor]) await expect(read(undefined, actor)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
});
it("requires an available fiscal calendar, rejects future knowledge and unsupported query escapes", async () => {
  await expect(read({ fromDate: "2028-01-01", toDateExclusive: "2029-01-01" })).rejects.toMatchObject({ code: "FISCAL_YEAR_REQUIRED" });
  await expect(read({ ...interval, knownAt: "9999-12-31T23:59:59.999999Z" })).rejects.toMatchObject({ code: "INVALID_REPORT_CUTOFF" });
  await expect(read({ ...interval, dimensions: { workerId: randomUUID() } })).rejects.toThrow();
});
it("returns exact zeros for a genuinely empty scoped ledger, not for denied scope", async () => {
  const report = await read(interval, finance, other); expect(report.trialBalance.rows).toEqual([]);
  expect(report.metadata.journalCount).toBe("0"); expect(report.metadata.ledgerWatermark).toBeNull();
  await expect(read(interval, reader, other)).rejects.toMatchObject({ status: 404 });
  await expect(readStatementFoundation(reader, randomUUID(), entity, interval)).rejects.toMatchObject({ status: 404 });
});
it("retains microseconds: exact posted timestamp includes a journal; one microsecond earlier excludes it", async () => {
  const timestamp = (await admin.query("SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS exact,to_char((created_at-interval '1 microsecond') AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS earlier FROM journal_entries WHERE id=$1", [initialJournal])).rows[0];
  expect((await read({ ...interval, knownAt: timestamp.earlier })).metadata.journalCount).toBe("0");
  expect((await read({ ...interval, knownAt: timestamp.exact })).balanceSheet.assets).toBe("114800.00");
});
it("reconstructs the captured cutoff after new backdated postings and identifies prior unclosed earnings separately", async () => {
  await post("2025-06-01", [{ accountId: accounts.BANK, debit: "10.00", credit: "0.00" }, { accountId: accounts.REVENUE, debit: "0.00", credit: "10.00" }]);
  const current = await read(interval);
  expect(current.incomeMovement.result).toBe("10300.00");
  expect(current.balanceSheet).toMatchObject({ assets: "114810.00", currentYearResult: "10300.00", priorUnclosedResult: "10.00", equity: "110310.00" });
  expect((await read()).balanceSheet.assets).toBe("114800.00");
});
it("uses consumed account versions, not mutable names, and nets balances across versions", async () => {
  await patchAccount(finance, org, entity, accounts.BANK, { name: "New asset name" }, 1, randomUUID());
  expect((await read(interval)).trialBalance.rows.find(row => row.accountId === accounts.BANK)).toMatchObject({ name: "BANK", accountVersions: [1] });
  await post("2026-03-01", [{ accountId: accounts.BANK, accountVersion: 2, debit: "0.00", credit: "0.01" }, { accountId: accounts.WAGES, debit: "0.01", credit: "0.00" }]);
  const report = await read(interval);
  expect(report.trialBalance.rows.find(row => row.accountId === accounts.BANK)).toMatchObject({ name: "New asset name", accountVersions: [1, 2], closing: { debit: "98509.99", credit: "0.00" } });
  expect(report.balanceSheet).toMatchObject({ currentYearResult: "10299.99", priorUnclosedResult: "10.00", difference: "0.00" });
  expect((await read()).trialBalance.rows.find(row => row.accountId === accounts.BANK)).toMatchObject({ name: "BANK", accountVersions: [1] });
});
it("revocation applies on the next read and runtime pool reuse cannot leak retained aggregates", async () => {
  await admin.query("UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2", [org, reader]);
  try { await expect(read()).rejects.toMatchObject({ status: 404 }); }
  finally { await admin.query("UPDATE memberships SET active=true WHERE organization_id=$1 AND user_id=$2", [org, reader]); }
  const client = await databasePool().connect();
  try { expect((await client.query("SELECT * FROM journal_lines")).rowCount).toBe(0); expect((await client.query("SELECT * FROM account_versions")).rowCount).toBe(0); }
  finally { client.release(); }
  expect((await withScope(reader, org, entity, "reports.read", client => client.query("SELECT DISTINCT legal_entity_id FROM journal_entries"))).rows).toEqual([{ legal_entity_id: entity }]);
});
it("captures new knowledge only after an in-flight scoped posting commits", async () => {
  const writer = await admin.connect(); let pending: ReturnType<typeof read> | undefined;
  try {
    await writer.query("BEGIN");
    await writer.query("SELECT set_config('app.user_id',$1,true),set_config('app.org_id',$2,true),set_config('app.entity_id',$3,true)", [finance, org, entity]);
    const receipt = await writeManualJournal(writer, org, entity, randomUUID(), { postingDate: "2026-04-01", documentDate: "2026-04-01", description: "In-flight report cutoff fixture", currency: "NPR", lines: [
      { accountId: accounts.BANK, accountVersion: 2, debit: "0.01", credit: "0.00", dimensions: {} },
      { accountId: accounts.REVENUE, accountVersion: 1, debit: "0.00", credit: "0.01", dimensions: {} },
    ] }, randomUUID());
    pending = read(interval);
    // Observe the actual database lock, not a timing guess about which promise
    // finishes first. The read's knowledge clock must be captured after commit.
    let waiting = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const locks = await admin.query("SELECT 1 FROM pg_stat_activity WHERE usename='kaamledger_app' AND wait_event_type='Lock' AND query LIKE '%app_security.lock_policy_scope%'");
      if (locks.rowCount) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    await writer.query("COMMIT");
    const report = await pending;
    const timestamp = (await admin.query("SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS instant FROM journal_entries WHERE id=$1", [receipt.id])).rows[0].instant as string;
    expect(report.metadata.knownAt >= timestamp).toBe(true);
    expect(report.metadata.journalCount).toBe("4");
    expect(report.balanceSheet).toMatchObject({ assets: "114810.00", currentYearResult: "10300.00", priorUnclosedResult: "10.00", difference: "0.00" });
    expect((await read({ ...interval, knownAt: report.metadata.knownAt })).balanceSheet).toEqual(report.balanceSheet);
  } finally {
    await writer.query("ROLLBACK"); writer.release();
    if (pending) await pending.catch(() => undefined);
  }
});
it("reads real account opening/movement/closing without inventing source links for primitive fixtures", async () => {
  const report = await readGeneralLedger(reader, org, entity, { ...interval, accountId: accounts.BANK, knownAt: initialCutoff });
  expect(report.totals).toEqual({ openingBalance: "0.00", periodDebit: "98500.00", periodCredit: "0.00", closingBalance: "98500.00", lineCount: "1" });
  expect(report.rows[0]).toMatchObject({ journalId: initialJournal, ordinal: 1, accountName: "BANK", accountVersion: 1, runningBalance: "98500.00", manualJournalId: null });
  expect(report.metadata).toMatchObject({ knownAt: initialCutoff, accountId: accounts.BANK, balanceConvention: "debit-positive", watermarkScope: "selected-account" });
  const creditAccount = await readGeneralLedger(reader, org, entity, { ...interval, accountId: accounts.CAPITAL, knownAt: initialCutoff });
  expect(creditAccount.totals.closingBalance).toBe("-100000.00"); expect(creditAccount.rows[0].runningBalance).toBe("-100000.00");
  const opening = await readGeneralLedger(reader, org, entity, { fromDate: "2026-03-01", toDateExclusive: "2027-01-01", accountId: accounts.BANK, knownAt: initialCutoff });
  expect(opening.rows).toEqual([]); expect(opening.page).toEqual({ precedingBalance: "98500.00", endingBalance: "98500.00", nextCursor: null });
});
it("paginates repeated account lines in one journal with stable ordinal ties and independent exact prefix balances", async () => {
  const receipt = await post("2026-05-01", Array.from({ length: 130 }, () => [
    { accountId: accounts.BANK, accountVersion: 2, debit: "0.01", credit: "0.00" },
    { accountId: accounts.CAPITAL, debit: "0.00", credit: "0.01" },
  ]).flat());
  const base = { fromDate: "2026-05-01", toDateExclusive: "2026-06-01", accountId: accounts.BANK, limit: 25 };
  let page = await readGeneralLedger(reader, org, entity, base);
  expect(page.totals).toEqual({ openingBalance: "98510.00", periodDebit: "1.30", periodCredit: "0.00", closingBalance: "98511.30", lineCount: "130" });
  const knownAt = page.metadata.knownAt, rows = [...page.rows];
  expect(page.page).toMatchObject({ precedingBalance: "98510.00", endingBalance: "98510.25" });
  let pages = 1;
  while (page.page.nextCursor) {
    const previousEnding = page.page.endingBalance;
    page = await readGeneralLedger(reader, org, entity, { ...base, cursor: page.page.nextCursor });
    expect(page.metadata.knownAt).toBe(knownAt); expect(page.page.precedingBalance).toBe(previousEnding);
    expect(page.rows.length).toBeLessThanOrEqual(25); rows.push(...page.rows); pages++;
  }
  expect(pages).toBe(6); expect(rows.map(row => row.ordinal)).toEqual(Array.from({ length: 130 }, (_, index) => index * 2 + 1));
  expect(new Set(rows.map(row => `${row.journalId}:${row.ordinal}`)).size).toBe(130);
  expect(rows.every(row => row.journalId === receipt.id && row.accountVersion === 2)).toBe(true);
  expect(page.page.endingBalance).toBe("98511.30");
});
it("pins later pages and retained names despite new backdated postings and unused metadata versions", async () => {
  const base = { fromDate: "2026-05-01", toDateExclusive: "2026-06-01", accountId: accounts.BANK, limit: 25 };
  const first = await readGeneralLedger(reader, org, entity, base), cursor = first.page.nextCursor!;
  const before = await readGeneralLedger(reader, org, entity, { ...base, cursor });
  await post("2026-05-01", [{ accountId: accounts.BANK, accountVersion: 2, debit: "0.02", credit: "0.00" }, { accountId: accounts.CAPITAL, debit: "0.00", credit: "0.02" }]);
  await patchAccount(finance, org, entity, accounts.BANK, { name: "Unused future metadata" }, 2, randomUUID());
  const after = await readGeneralLedger(reader, org, entity, { ...base, cursor });
  expect(after.rows).toEqual(before.rows); expect(after.totals).toEqual(before.totals); expect(after.account).toEqual(before.account);
  expect(after.metadata.knownAt).toBe(first.metadata.knownAt); expect(after.account.name).toBe("New asset name");
  const current = await readGeneralLedger(reader, org, entity, base);
  expect(current.totals.lineCount).toBe("131"); expect(current.totals.closingBalance).toBe("98511.32");
  expect(current.account).toMatchObject({ name: "New asset name", headerVersion: 2 });
});
it("checks real cursor anchors and rejects changed context, foreign accounts, missing scope and future cutoffs", async () => {
  const base = { fromDate: "2026-05-01", toDateExclusive: "2026-06-01", accountId: accounts.BANK, limit: 25 };
  const first = await readGeneralLedger(reader, org, entity, base), cursor = first.page.nextCursor!;
  const decoded = decodeLedgerCursor(cursor, org, entity, LedgerQuery.parse(base));
  await expect(readGeneralLedger(reader, org, entity, { ...base, cursor: encodeLedgerCursor({ ...decoded, ordinal: decoded.ordinal + 1 }) })).rejects.toMatchObject({ code: "INVALID_CURSOR", status: 400 });
  for (const patch of [{ accountId: accounts.CAPITAL }, { fromDate: "2026-05-02" }, { knownAt: initialCutoff }]) await expect(readGeneralLedger(reader, org, entity, { ...base, ...patch, cursor })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  await expect(readGeneralLedger(reader, org, entity, { ...base, accountId: randomUUID() })).rejects.toMatchObject({ status: 404 });
  await expect(readGeneralLedger(reader, org, other, base)).rejects.toMatchObject({ status: 404 });
  await expect(readGeneralLedger(reader, org, entity, { ...base, knownAt: "9999-12-31T23:59:59.999999Z" })).rejects.toMatchObject({ code: "INVALID_REPORT_CUTOFF" });
  for (const actor of [actors.owner, actors.organization_admin, actors.site_supervisor]) await expect(readGeneralLedger(actor, org, entity, base)).rejects.toMatchObject({ status: 403 });
});
it("retains the microsecond inclusion boundary and rechecks revoked access on cursor reads", async () => {
  const timestamp = (await admin.query("SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS exact,to_char((created_at-interval '1 microsecond') AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS earlier FROM journal_entries WHERE id=$1", [initialJournal])).rows[0];
  const base = { ...interval, accountId: accounts.BANK };
  expect((await readGeneralLedger(reader, org, entity, { ...base, knownAt: timestamp.earlier })).rows).toEqual([]);
  expect((await readGeneralLedger(reader, org, entity, { ...base, knownAt: timestamp.exact })).rows[0].runningBalance).toBe("98500.00");
  const first = await readGeneralLedger(reader, org, entity, { ...base, limit: 1 });
  await admin.query("UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2", [org, reader]);
  try { await expect(readGeneralLedger(reader, org, entity, { ...base, limit: 1, cursor: first.page.nextCursor! })).rejects.toMatchObject({ status: 404 }); }
  finally { await admin.query("UPDATE memberships SET active=true WHERE organization_id=$1 AND user_id=$2", [org, reader]); }
});
