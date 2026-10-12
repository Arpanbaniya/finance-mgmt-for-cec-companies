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
import { readOwnerStatementSummary } from "@/features/reporting/owner-statement-service";
import { OwnerStatementResult } from "@/features/reporting/contracts";
import { readReport } from "@/features/reporting/report-service";
import { decodeTrialCursor, encodeTrialCursor } from "@/features/reporting/trial-balance-cursor";
import { ReportQuery, ReportResult } from "@/features/reporting/report-contracts";
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
it("keeps legacy posted categories incomplete after later chart classification", async () => {
  const before = await read(), retained = (await admin.query("SELECT snapshot FROM account_versions WHERE account_id=$1 AND version=1", [accounts.WAGES])).rows[0].snapshot;
  expect(before.profitLoss).toMatchObject({ mappingComplete: false, netProfit: null, unclassifiedExpenses: "22700.00" });
  await patchAccount(finance, org, entity, accounts.WAGES, { reportMapping: { statementSection: "expenses", cashFlowCategory: "unclassified", profitLossCategory: "direct_cost", costBehavior: "variable" } }, 1, randomUUID());
  await patchAccount(finance, org, entity, accounts.REVENUE, { reportMapping: { statementSection: "revenue", cashFlowCategory: "unclassified", profitLossCategory: "revenue" } }, 1, randomUUID());
  expect((await read()).profitLoss).toEqual(before.profitLoss);
  expect((await admin.query("SELECT snapshot FROM account_versions WHERE account_id=$1 AND version=1", [accounts.WAGES])).rows[0].snapshot).toEqual(retained);
});
it("reads classified P&L from consumed versions, pins replay and does not retag old direct costs", async () => {
  await post("2026-06-03", [{ accountId: accounts.WAGES, accountVersion: 2, debit: "10.00", credit: "0.00" }, { accountId: accounts.REVENUE, accountVersion: 2, debit: "0.00", credit: "10.00" }]);
  const june = { fromDate: "2026-06-01", toDateExclusive: "2026-07-01" }, before = await read(june);
  expect(before.profitLoss).toMatchObject({ mappingComplete: true, operatingRevenue: "10.00", directCosts: "10.00", grossProfit: "0.00", contributionMargin: "0.00", netProfit: "0.00" });
  await patchAccount(finance, org, entity, accounts.WAGES, { reportMapping: { statementSection: "expenses", cashFlowCategory: "unclassified", profitLossCategory: "operating_expense", costBehavior: "fixed" } }, 2, randomUUID());
  expect((await read(june)).profitLoss).toEqual(before.profitLoss);
  await post("2026-06-04", [{ accountId: accounts.WAGES, accountVersion: 3, debit: "5.00", credit: "0.00" }, { accountId: accounts.REVENUE, accountVersion: 2, debit: "0.00", credit: "5.00" }]);
  const current = await read(june);
  expect(current.profitLoss).toMatchObject({ operatingRevenue: "15.00", directCosts: "10.00", operatingExpenses: "5.00", grossProfit: "5.00", contributionMargin: "5.00", operatingProfit: "0.00", profitBeforeTax: "0.00", netProfit: "0.00" });
  expect(current.incomeMovement.result).toBe("0.00"); expect(current.balanceSheet.difference).toBe("0.00");
  expect((await read({ ...june, knownAt: before.metadata.knownAt })).profitLoss).toEqual(before.profitLoss);
});

it("returns owner aggregate totals matching finance without raw identities at either boundary", async () => {
  const query = { ...interval, knownAt: initialCutoff };
  const summary = await readOwnerStatementSummary(actors.owner, org, entity, query), financial = await read(query);
  expect(summary.balanceSheet).toEqual(financial.balanceSheet);
  expect(summary.incomeMovement).toEqual({ revenue: "33000.00", expenses: "22700.00", result: "10300.00" });
  expect(summary.profitLoss).toMatchObject({ mappingComplete: false, contributionMappingComplete: false, grossProfit: null, netProfit: null });
  expect(OwnerStatementResult.safeParse(summary).success).toBe(true);
  const raw = await withScope(actors.owner, org, entity, "dashboard.owner", async client => {
    const result = await client.query("SELECT app_security.owner_statement_aggregates($1,$2,$3,$4,$5) AS summary", [org, entity, interval.fromDate, interval.toDateExclusive, initialCutoff]);
    for (const table of ["accounts", "account_versions", "journal_entries", "journal_lines", "journal_posting_sources", "manual_journal_revisions"]) {
      expect((await client.query(`SELECT * FROM ${table} WHERE organization_id=$1 AND legal_entity_id=$2`, [org, entity])).rows).toEqual([]);
    }
    return result.rows[0].summary;
  });
  for (const value of [summary, raw]) {
    const serialized = JSON.stringify(value);
    for (const secret of [...Object.values(accounts), initialJournal, "WAGES", "EMPLOYER", finance, "Independent ordinary-account", "accountId", "accountVersion", "retainedEarningsAccount", "journalCount", "unclassifiedAccounts", "missingCostBehavior"]) expect(serialized).not.toContain(secret);
  }
  expect(Object.keys(raw).sort()).toEqual(["buckets", "metadata"]);
  const role = await databasePool().query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
  expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
});
it("keeps owner classified subtotals tied across consumed versions and pinned knowledge", async () => {
  const query = { fromDate: "2026-06-01", toDateExclusive: "2026-07-01" };
  const financial = await read(query), summary = await readOwnerStatementSummary(actors.owner, org, entity, { ...query, knownAt: financial.metadata.knownAt });
  const { unclassifiedAccounts, missingCostBehavior, ...profitLoss } = financial.profitLoss;
  expect(unclassifiedAccounts).toEqual([]); expect(missingCostBehavior).toEqual([]);
  expect(summary.profitLoss).toEqual({ ...profitLoss, contributionMappingComplete: true });
  expect(summary.profitLoss).toMatchObject({ directCosts: "10.00", operatingExpenses: "5.00", contributionMargin: "5.00", netProfit: "0.00" });
  expect(summary.balanceSheet).toEqual(financial.balanceSheet);
  await post("2026-06-05", [{ accountId: accounts.AR, debit: "0.01", credit: "0.00" }, { accountId: accounts.REVENUE, accountVersion: 2, debit: "0.00", credit: "0.01" }]);
  expect((await readOwnerStatementSummary(actors.owner, org, entity, { ...query, knownAt: summary.metadata.knownAt })).profitLoss).toEqual(summary.profitLoss);
  expect((await readOwnerStatementSummary(actors.owner, org, entity, query)).profitLoss.netProfit).toBe("0.01");
});
it("denies owner aggregates for other roles, guessed scopes and direct SQL scope escapes", async () => {
  for (const actor of [reader, finance, actors.accountant, actors.organization_admin, actors.site_supervisor]) {
    await expect(readOwnerStatementSummary(actor, org, entity, interval)).rejects.toMatchObject({ status: 403 });
    await expect(withScope(actor, org, entity, "entity.read", client => client.query("SELECT app_security.owner_statement_aggregates($1,$2,$3,$4,NULL)", [org, entity, interval.fromDate, interval.toDateExclusive]))).rejects.toMatchObject({ code: "42501" });
  }
  await expect(readOwnerStatementSummary(actors.owner, org, other, interval)).rejects.toMatchObject({ status: 404 });
  await expect(readOwnerStatementSummary(actors.owner, randomUUID(), entity, interval)).rejects.toMatchObject({ status: 404 });
  for (const [company, organization] of [[other, org], [entity, randomUUID()], [null, org], [entity, null]]) {
    await expect(withScope(actors.owner, org, entity, "dashboard.owner", client => client.query("SELECT app_security.owner_statement_aggregates($1,$2,$3,$4,NULL)", [organization, company, interval.fromDate, interval.toDateExclusive]))).rejects.toMatchObject({ code: "42501" });
  }
  await expect(databasePool().query("SELECT app_security.owner_statement_aggregates($1,$2,$3,$4,NULL)", [org, entity, interval.fromDate, interval.toDateExclusive])).rejects.toMatchObject({ code: "42501" });
});
it("rechecks owner role and entity revocation and leaves pooled scope unset after rollback", async () => {
  const id = actors.owner;
  try {
    await admin.query("UPDATE memberships SET roles='[\"accountant\"]' WHERE organization_id=$1 AND user_id=$2", [org, id]);
    await expect(readOwnerStatementSummary(id, org, entity, interval)).rejects.toMatchObject({ status: 403 });
    await admin.query("UPDATE memberships SET roles='[\"owner\"]',allowed_entity_ids='[]' WHERE organization_id=$1 AND user_id=$2", [org, id]);
    await expect(readOwnerStatementSummary(id, org, entity, interval)).rejects.toMatchObject({ status: 404 });
    await admin.query("UPDATE memberships SET allowed_entity_ids=$3,active=false WHERE organization_id=$1 AND user_id=$2", [org, id, JSON.stringify([entity])]);
    await expect(readOwnerStatementSummary(id, org, entity, interval)).rejects.toMatchObject({ status: 404 });
  } finally { await admin.query("UPDATE memberships SET roles='[\"owner\"]',allowed_entity_ids=$3,active=true WHERE organization_id=$1 AND user_id=$2", [org, id, JSON.stringify([entity])]); }
  const scope = await databasePool().query("SELECT nullif(current_setting('app.user_id',true),'') AS actor,nullif(current_setting('app.org_id',true),'') AS org,nullif(current_setting('app.entity_id',true),'') AS entity");
  expect(scope.rows[0]).toEqual({ actor: null, org: null, entity: null });
  expect((await readOwnerStatementSummary(id, org, entity, { ...interval, knownAt: initialCutoff })).balanceSheet.assets).toBe("114800.00");
  await expect(read(undefined, id)).rejects.toMatchObject({ status: 403 });
});
it("validates owner intervals, fiscal setup, microsecond bounds and untrusted filters", async () => {
  await expect(readOwnerStatementSummary(actors.owner, org, entity, { fromDate: "2028-01-01", toDateExclusive: "2029-01-01" })).rejects.toMatchObject({ code: "FISCAL_YEAR_REQUIRED" });
  await expect(readOwnerStatementSummary(actors.owner, org, entity, { ...interval, knownAt: "9999-12-31T23:59:59.999999Z" })).rejects.toMatchObject({ code: "INVALID_REPORT_CUTOFF" });
  for (const field of ["accountId", "workerId", "dimensions", "cursor", "sql"]) await expect(readOwnerStatementSummary(actors.owner, org, entity, { ...interval, [field]: "not permitted" })).rejects.toThrow();
  const at = (await admin.query("SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS at,to_char((created_at-interval '1 microsecond') AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS before FROM journal_entries WHERE id=$1", [initialJournal])).rows[0];
  expect((await readOwnerStatementSummary(actors.owner, org, entity, { ...interval, knownAt: at.at })).balanceSheet.assets).toBe("114800.00");
  const empty = await readOwnerStatementSummary(actors.owner, org, entity, { ...interval, knownAt: at.before });
  expect(empty.balanceSheet.assets).toBe("0.00"); expect(empty.metadata.ledgerWatermark).toBeNull(); expect(empty.profitLoss.netProfit).toBe("0.00");
  for (const [start, end, knowledge] of [[null, interval.toDateExclusive, null], [interval.fromDate, interval.fromDate, null], ["-infinity", interval.toDateExclusive, null], [interval.fromDate, "infinity", null], [interval.fromDate, interval.toDateExclusive, "infinity"]]) {
    await expect(withScope(actors.owner, org, entity, "dashboard.owner", client => client.query("SELECT app_security.owner_statement_aggregates($1,$2,$3,$4,$5)", [org, entity, start, end, knowledge]))).rejects.toMatchObject({ code: "22023" });
  }
});
it("keeps the aggregate definer private and immune to temporary-table shadowing", async () => {
  const privileges = await admin.query("SELECT p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) AS owner,EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app_security' AND p.proname='owner_statement_aggregates'");
  expect(privileges.rows[0]).toMatchObject({ prosecdef: true, public_execute: false, proconfig: ["search_path=pg_catalog, public, pg_temp"] });
  expect(privileges.rows[0].owner).not.toBe("kaamledger_app");
  await withScope(actors.owner, org, entity, "dashboard.owner", async client => {
    await client.query("CREATE TEMP TABLE journal_entries (id uuid) ON COMMIT DROP");
    await client.query("CREATE TEMP TABLE memberships (organization_id uuid) ON COMMIT DROP");
    const result = await client.query("SELECT app_security.owner_statement_aggregates($1,$2,$3,$4,$5) AS summary", [org, entity, interval.fromDate, interval.toDateExclusive, initialCutoff]);
    expect(result.rows[0].summary.buckets).not.toEqual([]);
    expect(result.rows[0].summary.metadata.ledgerWatermark).not.toBeNull();
  });
});
it("denies a role revoked while the owner read is waiting for the organization lock", async () => {
  const revoker = await admin.connect(); let pending: Promise<unknown> | undefined;
  try {
    await revoker.query("BEGIN");
    await revoker.query("UPDATE memberships SET roles='[\"accountant\"]' WHERE organization_id=$1 AND user_id=$2", [org, actors.owner]);
    pending = readOwnerStatementSummary(actors.owner, org, entity, interval).then(result => ({ result }), error => ({ error }));
    let waiting = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const locks = await admin.query("SELECT 1 FROM pg_stat_activity WHERE usename='kaamledger_app' AND wait_event_type='Lock' AND query LIKE '%app_security.owner_statement_aggregates%'");
      if (locks.rowCount) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true); await revoker.query("COMMIT");
    expect(await pending).toMatchObject({ error: { code: "FORBIDDEN", status: 403 } });
  } finally {
    await revoker.query("ROLLBACK"); revoker.release(); if (pending) await pending;
    await admin.query("UPDATE memberships SET roles='[\"owner\"]' WHERE organization_id=$1 AND user_id=$2", [org, actors.owner]);
  }
});
it("captures owner knowledge after an observed in-flight posting commits", async () => {
  const writer = await admin.connect(); let pending: ReturnType<typeof readOwnerStatementSummary> | undefined;
  const before = await readOwnerStatementSummary(actors.owner, org, entity, interval);
  try {
    await writer.query("BEGIN");
    await writer.query("SELECT set_config('app.user_id',$1,true),set_config('app.org_id',$2,true),set_config('app.entity_id',$3,true)", [finance, org, entity]);
    const posted = await writeManualJournal(writer, org, entity, randomUUID(), { postingDate: "2026-07-01", documentDate: "2026-07-01", description: "Owner cutoff commit fixture", currency: "NPR", lines: [
      { accountId: accounts.BANK, accountVersion: 3, debit: "0.01", credit: "0.00", dimensions: {} },
      { accountId: accounts.REVENUE, accountVersion: 2, debit: "0.00", credit: "0.01", dimensions: {} },
    ] }, randomUUID());
    pending = readOwnerStatementSummary(actors.owner, org, entity, interval);
    let waiting = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const locks = await admin.query("SELECT 1 FROM pg_stat_activity WHERE usename='kaamledger_app' AND wait_event_type='Lock' AND query LIKE '%app_security.owner_statement_aggregates%'");
      if (locks.rowCount) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true); await writer.query("COMMIT");
    const result = await pending;
    const financial = await read({ ...interval, knownAt: result.metadata.knownAt });
    const timestamp = (await admin.query("SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS at FROM journal_entries WHERE id=$1", [posted.id])).rows[0].at;
    expect(result.metadata.knownAt >= timestamp).toBe(true); expect(result.balanceSheet).toEqual(financial.balanceSheet);
    expect((await readOwnerStatementSummary(actors.owner, org, entity, { ...interval, knownAt: before.metadata.knownAt })).balanceSheet).toEqual(before.balanceSheet);
    expect(result.balanceSheet.assets).not.toBe(before.balanceSheet.assets);
  } finally { await writer.query("ROLLBACK"); writer.release(); if (pending) await pending.catch(() => undefined); }
});
it("exposes strict public variants with whole-report totals and reauthorized stable trial pagination", async () => {
  const query = { reportType: "trial-balance", ...interval, knownAt: initialCutoff, limit: 2 };
  let report = await readReport(reader, org, entity, query); expect(ReportResult.safeParse(report).success).toBe(true);
  if (report.reportType !== "trial-balance") throw Error("Wrong variant");
  expect(report.totals.closing).toEqual({ debit: "137500.00", credit: "137500.00" });
  const ids = report.rows.map(row => row.accountId), knownAt = report.metadata.knownAt, firstCursor = report.page.nextCursor!;
  while (report.page.nextCursor) {
    const next = await readReport(reader, org, entity, { ...query, knownAt: undefined, cursor: report.page.nextCursor });
    if (next.reportType !== "trial-balance") throw Error("Wrong variant"); report = next;
    expect(report.rows.length).toBeLessThanOrEqual(2); expect(report.metadata.knownAt).toBe(knownAt); expect(report.totals.closing.debit).toBe("137500.00"); ids.push(...report.rows.map(row => row.accountId));
  }
  expect(ids).toHaveLength(9); expect(new Set(ids).size).toBe(9);
  const cursor = decodeTrialCursor(firstCursor, org, entity, ReportQuery.parse(query));
  await expect(readReport(reader, org, entity, { ...query, cursor: encodeTrialCursor({ ...cursor, accountId: randomUUID() }) })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  await expect(readReport(reader, org, entity, { ...query, fromDate: "2026-02-01", cursor: firstCursor })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  await admin.query("UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2", [org, reader]);
  try { await expect(readReport(reader, org, entity, { ...query, cursor: firstCursor })).rejects.toMatchObject({ status: 404 }); }
  finally { await admin.query("UPDATE memberships SET active=true WHERE organization_id=$1 AND user_id=$2", [org, reader]); }
});
it("keeps public owner P&L/BS minimal while finance raw variants retain their own permissions", async () => {
  const pl = await readReport(actors.owner, org, entity, { reportType: "profit-loss", ...interval, knownAt: initialCutoff });
  expect(pl).toMatchObject({ reportType: "profit-loss", view: "owner", totals: { mappingComplete: false, netProfit: null }, incomeMovement: { result: "10300.00" } });
  const bs = await readReport(actors.owner, org, entity, { reportType: "balance-sheet", asOfDate: "2026-12-31", knownAt: initialCutoff });
  expect(bs).toMatchObject({ totals: { assets: "114800.00", equity: "110300.00", difference: "0.00" } });
  for (const item of [pl, bs]) for (const forbidden of ["accountId", "accountVersion", "journalCount", "retainedEarningsAccount", "unclassifiedAccounts", ...Object.values(accounts)]) expect(JSON.stringify(item)).not.toContain(forbidden);
  for (const reportType of ["trial-balance", "general-ledger"]) await expect(readReport(actors.owner, org, entity, { reportType, ...interval, ...(reportType === "general-ledger" ? { accountId: accounts.BANK } : {}) })).rejects.toMatchObject({ status: 403 });
  const ledger = await readReport(reader, org, entity, { reportType: "general-ledger", ...interval, accountId: accounts.BANK, knownAt: initialCutoff });
  expect(ledger).toMatchObject({ reportType: "general-ledger", view: "finance", totals: { closingBalance: "98500.00" } });
  const financePl = await readReport(reader, org, entity, { reportType: "profit-loss", ...interval, knownAt: initialCutoff });
  if (financePl.reportType !== "profit-loss" || pl.reportType !== "profit-loss") throw Error("Wrong variant");
  expect(financePl.totals).toEqual(pl.totals);
});
it("fails explicitly for deferred capabilities without revealing another entity", async () => {
  await expect(readReport(reader, org, entity, { reportType: "cash-flow" })).rejects.toMatchObject({ code: "FEATURE_NOT_ENABLED" });
  await expect(readReport(reader, org, other, { reportType: "cash-flow" })).rejects.toMatchObject({ status: 404 });
  await expect(readReport(actors.site_supervisor, org, entity, { reportType: "cash-flow" })).rejects.toMatchObject({ status: 403 });
  await expect(readReport(reader, org, entity, { reportType: "profit-loss", ...interval, includeComparative: true })).rejects.toMatchObject({ code: "FEATURE_NOT_ENABLED" });
});
it("keeps unfiltered journal reads scoped and finance-only with statement-local authorization", async () => {
  for (const role of ["finance_manager", "accountant", "auditor", "owner", "organization_admin", "site_supervisor"]) {
    await withScope(actors[role], org, entity, "entity.read", async client => {
      for (const table of ["journal_entries", "journal_lines"]) {
        const rows = (await client.query(`SELECT organization_id,legal_entity_id FROM ${table}`)).rows;
        expect(rows.every(row => row.organization_id === org && row.legal_entity_id === entity)).toBe(true);
        if (["finance_manager", "accountant", "auditor"].includes(role)) expect(rows.length).toBeGreaterThan(0);
        else expect(rows).toEqual([]);
        const grants = (await client.query("SELECT has_table_privilege(current_user,$1,'INSERT') OR has_table_privilege(current_user,$1,'UPDATE') OR has_table_privilege(current_user,$1,'DELETE') AS writable", [table])).rows[0];
        expect(grants.writable).toBe(false);
      }
    });
  }
});
it("reauthorizes a reused prepared ledger query per statement, including revocation in the same transaction", async () => {
  const client = await databasePool().connect();
  const prepared = { name: `statement-local-rls-${randomUUID()}`, text: "SELECT (SELECT count(*)::int FROM journal_entries) AS entries,(SELECT count(*)::int FROM journal_lines) AS lines" };
  const setScope = (actor: string, organization: string = org, company: string = entity) => client.query("SELECT set_config('app.user_id',$1,true),set_config('app.org_id',$2,true),set_config('app.entity_id',$3,true)", [actor, organization, company]);
  try {
    await client.query("BEGIN"); await setScope(reader);
    expect((await client.query(prepared)).rows[0].lines).toBeGreaterThan(0);
    await admin.query("UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2", [org, reader]);
    expect((await client.query(prepared)).rows[0]).toEqual({ entries: 0, lines: 0 });
    await admin.query("UPDATE memberships SET active=true WHERE organization_id=$1 AND user_id=$2", [org, reader]);
    expect((await client.query(prepared)).rows[0].entries).toBeGreaterThan(0);
    await client.query("ROLLBACK");
    for (const [actor, organization, company] of [[actors.owner, org, entity], [reader, org, other], [reader, randomUUID(), entity], [reader, "", ""]]) {
      await client.query("BEGIN"); await setScope(actor, organization, company);
      expect((await client.query(prepared)).rows[0]).toEqual({ entries: 0, lines: 0 });
      await client.query("ROLLBACK");
    }
    // Scope was transaction-local even though the prepared plan survived.
    expect((await client.query(prepared)).rows[0]).toEqual({ entries: 0, lines: 0 });
    await client.query("BEGIN"); await setScope(reader, "invalid", entity);
    await expect(client.query(prepared)).rejects.toMatchObject({ code: "22P02" });
  } finally {
    await client.query("ROLLBACK"); client.release();
    await admin.query("UPDATE memberships SET active=true WHERE organization_id=$1 AND user_id=$2", [org, reader]);
  }
});
it("uses once-per-statement permission InitPlans without disabling row security", async () => {
  await withScope(reader, org, entity, "reports.read", async client => {
    for (const table of ["journal_entries", "journal_lines"]) {
      const plan = (await client.query(`EXPLAIN (ANALYZE,FORMAT JSON) SELECT count(*) FROM ${table}`)).rows[0]["QUERY PLAN"][0];
      const guards: Record<string, unknown>[] = [];
      function collect(node: Record<string, unknown>) {
        if (String(node["Subplan Name"] ?? "").startsWith("InitPlan")) guards.push(node);
        for (const child of (node.Plans ?? []) as Record<string, unknown>[]) collect(child);
      }
      collect(plan.Plan); expect(guards).toHaveLength(2);
      expect(guards.every(node => node["Actual Loops"] === 1)).toBe(true);
      expect((await client.query("SHOW row_security")).rows[0].row_security).toBe("on");
    }
  });
});
