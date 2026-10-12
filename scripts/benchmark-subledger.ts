import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { cpus, totalmem, platform, arch } from "node:os";
import { performance } from "node:perf_hooks";
import { Pool, type PoolClient } from "pg";
import { databasePool } from "../db/client";
import { withScope } from "../features/identity/scope";
import { createAccount } from "../features/accounting/accounts-service";
import { createFiscalYear } from "../features/accounting/setup-service";
import { writeManualJournal } from "../features/accounting/posting-kernel";
import { OpenBalancesSQL, readOpenBalances, writeSubledgerSource } from "../features/accounting/subledger-service";
import type { SubledgerSourceValue } from "../domain/subledger-source";
import { GeneralLedgerSQL, readGeneralLedger } from "../features/reporting/general-ledger-service";
import { readStatementFoundation } from "../features/reporting/statement-service";
import { withLedgerReportScope } from "../features/reporting/scope";
import { encodeLedgerCursor } from "../features/reporting/ledger-cursor";
import { StatementAggregatesSQL } from "../features/reporting/statement-service";
import { readReport } from "../features/reporting/report-service";
import { parseReportQuery } from "../features/reporting/report-query";
import type { ReportResultValue } from "../features/reporting/report-contracts";
import assert from "node:assert/strict";

config({ path: ".env.local", quiet: true });
for (const name of ["MIGRATION_DATABASE_URL", "DATABASE_URL"]) {
  let url: URL;
  try { url = new URL(process.env[name] ?? ""); } catch { throw new Error(`${name} must be configured privately for the dedicated local database.`); }
  if (url.hostname !== "127.0.0.1" || url.port !== "55432" || url.pathname !== "/kaamledger") throw new Error("Benchmark writes require the dedicated local database on port 55432; hosted databases are forbidden.");
}
const org = randomUUID(), entity = randomUUID(), party = randomUUID(), user = `subledger-benchmark-${randomUUID()}`, owner = `report-owner-${randomUUID()}`;
const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const accounts: Record<string, string> = {}, samples: number[] = [], historySamples: number[] = [], growth: number[] = [];
const query = { asOfDate: "2026-12-31", knownAt: "9999-12-31T23:59:59.999999Z", limit: 100 };
async function internal<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id',$1,true),set_config('app.org_id',$2,true),set_config('app.entity_id',$3,true)", [user, org, entity]);
    const result = await work(client); await client.query("COMMIT"); return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
const post = (body: SubledgerSourceValue, source = randomUUID()) => internal(client => writeSubledgerSource(client, org, entity, source, body, randomUUID()));
const day = (offset: number) => new Date(Date.UTC(2026, 0, 15 + offset)).toISOString().slice(0, 10);
const p95 = (values: number[]) => Number([...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1].toFixed(3));
const started = performance.now();
const includeReports = process.argv.includes("--reports");
const publicReports = process.argv.includes("--public-reports");
const planOnly = process.argv.includes("--report-plan-only");
try {
  await admin.query("INSERT INTO auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Local subledger benchmark',$2,true,now(),now())", [user, `${user}@example.invalid`]);
  await admin.query("INSERT INTO organizations(id,name) VALUES($1,'Local subledger benchmark')", [org]);
  await admin.query("INSERT INTO legal_entities(id,organization_id,name,active_modes,reporting_profile,created_by) VALUES($1,$2,'Synthetic benchmark company','[\"labour\"]','demo_accrual',$3)", [entity, org, user]);
  await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,'[\"finance_manager\"]',$4,'[]')", [randomUUID(), org, user, JSON.stringify([entity])]);
  if (publicReports || planOnly) {
    await admin.query("INSERT INTO auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Local report owner',$2,true,now(),now())", [owner, `${owner}@example.invalid`]);
    await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,'[\"owner\"]',$4,'[]')", [randomUUID(), org, owner, JSON.stringify([entity])]);
  }
  for (const [code, type, control] of [["ar", "asset", "ar"], ["deposit", "liability", "customer_deposits"], ["cash", "asset", "cash"], ["revenue", "revenue", null], ["expense", "expense", null], ["equity", "equity", null]] as const) {
    const account = await createAccount(user, org, entity, { code, name: code, type, normalSide: type === "asset" || type === "expense" ? "debit" : "credit", isControl: control !== null, controlType: control, reportMapping: { statementSection: type === "asset" ? "assets" : type === "liability" ? "liabilities" : type === "equity" ? "equity" : type === "revenue" ? "revenue" : "expenses", cashFlowCategory: control === "cash" ? "cash" : "unclassified", profitLossCategory: type === "revenue" ? "revenue" : type === "expense" ? "operating_expense" : "not_applicable", costBehavior: type === "expense" ? "fixed" : "not_applicable" } }, randomUUID(), randomUUID()); accounts[code] = account.id;
  }
  await createFiscalYear(user, org, entity, { fiscalYearLabel: "Synthetic benchmark year", retainedEarningsAccountId: accounts.equity, periods: [{ startDate: "2026-01-01", endDateExclusive: "2027-01-01" }] }, randomUUID(), randomUUID());
  await internal(client => client.query("INSERT INTO subledger_counterparties VALUES($1,$2,$3,$4)", [org, entity, party, user]));
  let target = "";
  for (let i = 0; i < 500; i++) {
    const source = randomUUID();
    await post({ kind: "ar_item", postingDate: "2026-01-01", documentDate: "2026-01-01", dueDate: "2026-01-31", partyId: party, amount: "10000.00", controlAccountId: accounts.ar, counterAccountId: accounts.revenue }, source);
    if (!i) target = (await admin.query("SELECT id FROM subledger_open_items WHERE source_id=$1", [source])).rows[0].id;
  }
  const settlement = randomUUID();
  await post({ kind: "ar_deposit", postingDate: "2026-01-10", documentDate: "2026-01-10", partyId: party, amount: "10000.00", controlAccountId: accounts.deposit, counterAccountId: accounts.cash }, settlement);
  for (let i = 0; i < 100; i++) {
    const source = randomUUID(), tick = performance.now();
    await post({ kind: "application", postingDate: day(i * 2), documentDate: day(i * 2), settlementId: settlement, openItemId: target, amount: "0.01" }, source);
    const allocation = (await admin.query("SELECT id FROM subledger_allocations WHERE source_id=$1", [source])).rows[0].id;
    await post({ kind: "allocation_reverse", postingDate: day(i * 2 + 1), documentDate: day(i * 2 + 1), reversalOf: allocation, reason: "Synthetic history-growth inverse" });
    growth.push(performance.now() - tick);
    if ((i + 1) % 25 === 0) console.log(`History growth: ${(i + 1) * 2} immutable events`);
  }
  let lineCount = (await admin.query("SELECT count(*)::int AS n FROM journal_lines WHERE organization_id=$1", [org])).rows[0].n as number;
  while (lineCount < 100000) {
    const count = Math.min(500, 100000 - lineCount);
    const lines = Array.from({ length: count }, (_, i) => ({ accountId: accounts[i < count / 2 ? "expense" : "equity"], accountVersion: 1, debit: i < count / 2 ? "0.01" : "0.00", credit: i < count / 2 ? "0.00" : "0.01", dimensions: {} }));
    await internal(client => writeManualJournal(client, org, entity, randomUUID(), { postingDate: "2026-01-01", documentDate: "2026-01-01", description: "Synthetic local ledger-size fixture", currency: "NPR", lines }, randomUUID()));
    lineCount += count;
    if (lineCount % 10000 < 500) console.log(`Valid balanced ledger: ${lineCount} lines`);
  }
  for (const table of ["subledger_open_items", "subledger_allocations", "journal_lines", "memberships"]) await admin.query(`ANALYZE ${table}`);
  for (let i = 0; i < 5; i++) await readOpenBalances(user, org, entity, query);
  for (let i = 0; i < 50; i++) {
    const tick = performance.now(), page = await readOpenBalances(user, org, entity, query); samples.push(performance.now() - tick);
    if (page.data.length !== 100 || !page.nextCursor || page.data.some(row => row.originalAmount !== "10000.00" || row.outstandingAmount !== "10000.00")) throw new Error("Independent expected page balance/count failed");
  }
  const ids: string[] = []; let after: string | undefined;
  do {
    const page = await readOpenBalances(user, org, entity, { ...query, after }); ids.push(...page.data.map(row => row.id)); after = page.nextCursor ?? undefined;
  } while (after);
  if (ids.length !== 500 || new Set(ids).size !== 500) throw new Error("Bounded pages lost or duplicated origins");
  const predecessors = (await admin.query("SELECT id FROM subledger_open_items WHERE organization_id=$1 AND legal_entity_id=$2 AND id<$3 ORDER BY id DESC LIMIT 50", [org, entity, target])).rows;
  const historyQuery = { ...query, after: predecessors.at(-1)?.id as string | undefined, asOfDate: day(198) };
  for (let i = 0; i < 5; i++) await readOpenBalances(user, org, entity, historyQuery);
  for (let i = 0; i < 50; i++) {
    const tick = performance.now(), page = await readOpenBalances(user, org, entity, historyQuery); historySamples.push(performance.now() - tick);
    const origin = page.data.find(row => row.id === target);
    if (!origin || origin.allocatedAmount !== "0.01" || origin.outstandingAmount !== "9999.99") throw new Error("Historical page did not reconstruct the last application before its future inverse");
  }
  const plan = await withScope(user, org, entity, "journals.read", async client => (await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${OpenBalancesSQL}`, [org, entity, query.asOfDate, query.knownAt, null, 101])).rows[0]["QUERY PLAN"][0]);
  const footprint: Record<string, unknown>[] = [];
  function visit(node: Record<string, unknown>) {
    if (node["Relation Name"] || node["Node Type"] === "Limit") footprint.push({ node: node["Node Type"], relation: node["Relation Name"], index: node["Index Name"], rows: node["Actual Rows"], loops: node["Actual Loops"] });
    for (const child of (node.Plans ?? []) as Record<string, unknown>[]) visit(child);
  }
  visit(plan.Plan);
  let publicReporting: Record<string, unknown> | undefined;
  if (publicReports || planOnly) {
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM journal_lines WHERE organization_id=$1 AND legal_entity_id=$2", [org, entity])).rows[0].n, 100000);
    const interval = { fromDate: "2026-01-01", toDateExclusive: "2027-01-01" };
    const financePlan = await withLedgerReportScope(user, org, entity, async client => (await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${StatementAggregatesSQL}`, [org, entity, interval.fromDate, interval.toDateExclusive, null])).rows[0]["QUERY PLAN"][0]);
    const financeFootprint: Record<string, unknown>[] = [];
    function collectPlan(node: Record<string, unknown>) {
      if (node["Relation Name"] || node["Node Type"] === "Limit" || node["Subplan Name"]) financeFootprint.push({ node: node["Node Type"], subplan: node["Subplan Name"], relation: node["Relation Name"], index: node["Index Name"], rows: node["Actual Rows"], loops: node["Actual Loops"], filter: node.Filter });
      for (const child of (node.Plans ?? []) as Record<string, unknown>[]) collectPlan(child);
    }
    collectPlan(financePlan.Plan);
    console.log(JSON.stringify({ financeStatementPlan: { executionMs: financePlan["Execution Time"], footprint: financeFootprint } }, null, 2));
    if (!planOnly) {
      const first = await readGeneralLedger(user, org, entity, { accountId: accounts.expense, ...interval, limit: 100 }), knownAt = first.metadata.knownAt;
      const midpoint = (await admin.query("SELECT j.id,l.ordinal FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_id WHERE l.organization_id=$1 AND l.legal_entity_id=$2 AND l.account_id=$3 ORDER BY j.posting_date,j.id,l.ordinal OFFSET 24649 LIMIT 1", [org, entity, accounts.expense])).rows[0];
      const middle = encodeLedgerCursor({ version: 1, organizationId: org, entityId: entity, accountId: accounts.expense, ...interval, knownAt, postingDate: "2026-01-01", journalId: midpoint.id, ordinal: midpoint.ordinal });
      const measurements: Record<string, unknown> = {};
      const readPublic = async (actor: string, type: string, fields: Record<string, string | undefined>) => readReport(actor, org, entity, parseReportQuery(type,
        new URLSearchParams(Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined))));
      const verify = (report: ReportResultValue, label: string) => {
        assert.equal(report.metadata.knownAt, knownAt);
        if (report.reportType === "profit-loss") {
          assert.equal(report.totals.operatingRevenue, "5000000.00"); assert.equal(report.totals.operatingExpenses, "492.99");
          assert.equal(report.totals.grossProfit, "5000000.00"); assert.equal(report.totals.contributionMargin, "5000000.00"); assert.equal(report.totals.netProfit, "4999507.01");
          assert.equal(report.totals.mappingComplete, true); assert.equal(report.totals.contributionMappingComplete, true);
        } else if (report.reportType === "balance-sheet") {
          assert.deepEqual(report.totals, { assets: "5010000.00", liabilities: "10000.00", postedEquity: "492.99", currentYearResult: "4999507.01", priorUnclosedResult: "0.00", equity: "5000000.00", difference: "0.00" });
        } else if (report.reportType === "trial-balance") {
          assert.equal(report.rows.length, 6); assert.equal(report.page.totalRows, 6); assert.equal(report.page.nextCursor, null); assert.deepEqual(report.totals.closing, { debit: "5010492.99", credit: "5010492.99" });
        } else {
          assert.equal(report.rows.length, 100); assert.equal(report.totals.lineCount, "49299"); assert.equal(report.totals.closingBalance, "492.99");
          assert.equal(report.page.precedingBalance, label === "ledgerMiddle" ? "246.50" : "0.00"); assert.equal(report.page.endingBalance, label === "ledgerMiddle" ? "247.50" : "1.00");
          assert.ok(report.page.nextCursor); assert.ok(report.rows.every(row => row.debit === "0.01" && row.credit === "0.00"));
        }
        if (report.view === "owner") for (const id of Object.values(accounts)) assert.ok(!JSON.stringify(report).includes(id));
      };
      const cases = [
        { label: "ledgerFirst", actor: user, type: "general-ledger", fields: { ...interval, knownAt, accountId: accounts.expense, limit: "100" } },
        { label: "ledgerMiddle", actor: user, type: "general-ledger", fields: { ...interval, knownAt, accountId: accounts.expense, limit: "100", cursor: middle } },
        { label: "trialBalance", actor: user, type: "trial-balance", fields: { ...interval, knownAt, limit: "100" } },
        ...[user, owner].flatMap(actor => [{ label: actor === user ? "financeProfitLoss" : "ownerProfitLoss", actor, type: "profit-loss", fields: { ...interval, knownAt } },
          { label: actor === user ? "financeBalanceSheet" : "ownerBalanceSheet", actor, type: "balance-sheet", fields: { asOfDate: "2026-12-31", knownAt } }]),
      ];
      for (const entry of cases) {
        for (let i = 0; i < 5; i++) verify(await readPublic(entry.actor, entry.type, entry.fields), entry.label);
        const times: number[] = [];
        for (let i = 0; i < 50; i++) {
          const tick = performance.now(), report = await readPublic(entry.actor, entry.type, entry.fields); times.push(performance.now() - tick); verify(report, entry.label);
          if ((i + 1) % 10 === 0) console.log(`Public ${entry.label}: ${i + 1}/50 authorized reads`);
        }
        measurements[entry.label] = { runs: 50, p95Ms: p95(times), maxMs: Number(Math.max(...times).toFixed(3)), targetMet: p95(times) < 3000 };
        console.log(JSON.stringify({ report: entry.label, ...measurements[entry.label] as Record<string, unknown> }));
      }
      publicReporting = { measurements, independentTies: true, adapter: "strict URL query plus authorized readReport; excludes HTTP/session/render latency", financeStatementPlan: { executionMs: financePlan["Execution Time"], footprint: financeFootprint } };
    }
  }
  let reporting: Record<string, unknown> | undefined;
  if (includeReports) {
    const ledgerQuery = { accountId: accounts.expense, fromDate: "2026-01-01", toDateExclusive: "2026-01-02", limit: 100 };
    const first = await readGeneralLedger(user, org, entity, ledgerQuery), knowledge = first.metadata.knownAt;
    if (lineCount !== 100000 || first.totals.lineCount !== "49299" || first.totals.periodDebit !== "492.99" || first.totals.closingBalance !== "492.99") throw new Error("Independent dense-ledger totals failed");
    const midpoint = (await admin.query(`SELECT j.id,l.ordinal FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_id
      WHERE l.organization_id=$1 AND l.legal_entity_id=$2 AND l.account_id=$3 ORDER BY j.posting_date,j.id,l.ordinal OFFSET 24649 LIMIT 1`, [org, entity, accounts.expense])).rows[0];
    const midCursor = encodeLedgerCursor({ version: 1, organizationId: org, entityId: entity, accountId: accounts.expense,
      fromDate: ledgerQuery.fromDate, toDateExclusive: ledgerQuery.toDateExclusive, knownAt: knowledge, postingDate: "2026-01-01", journalId: midpoint.id, ordinal: midpoint.ordinal });
    const initialQuery = { ...ledgerQuery, knownAt: knowledge }, middleQuery = { ...initialQuery, cursor: midCursor };
    const firstSamples: number[] = [], middleSamples: number[] = [], statementSamples: number[] = [];
    for (const [label, input, measurements, preceding, ending] of [["first", initialQuery, firstSamples, "0.00", "1.00"], ["middle", middleQuery, middleSamples, "246.50", "247.50"]] as const) {
      for (let i = 0; i < 5; i++) await readGeneralLedger(user, org, entity, input);
      for (let i = 0; i < 50; i++) {
        const tick = performance.now(), page = await readGeneralLedger(user, org, entity, input); measurements.push(performance.now() - tick);
        if (page.rows.length !== 100 || page.rows.some(row => row.debit !== "0.01" || row.credit !== "0.00") || page.page.precedingBalance !== preceding || page.page.endingBalance !== ending || !page.page.nextCursor) throw new Error(`Independent ${label} page balances/count failed`);
        if ((i + 1) % 10 === 0) console.log(`Dense ledger ${label} page: ${i + 1}/50 reads`);
      }
    }
    const statementQuery = { fromDate: "2026-01-01", toDateExclusive: "2027-01-01", knownAt: knowledge };
    for (let i = 0; i < 5; i++) await readStatementFoundation(user, org, entity, statementQuery);
    for (let i = 0; i < 50; i++) {
      const tick = performance.now(), report = await readStatementFoundation(user, org, entity, statementQuery); statementSamples.push(performance.now() - tick);
      if (report.trialBalance.totals.closing.debit !== "5010492.99" || report.trialBalance.totals.closing.credit !== "5010492.99"
        || report.balanceSheet.assets !== "5010000.00" || report.balanceSheet.liabilities !== "10000.00"
        || report.balanceSheet.equity !== "5000000.00" || report.balanceSheet.currentYearResult !== "4999507.01" || report.balanceSheet.difference !== "0.00") throw new Error("Independent large statement fixture ties failed");
      if ((i + 1) % 10 === 0) console.log(`Posted statements: ${i + 1}/50 reads`);
    }
    const reportPlan = await withLedgerReportScope(user, org, entity, async client => (await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${GeneralLedgerSQL}`,
      [org, entity, accounts.expense, ledgerQuery.fromDate, ledgerQuery.toDateExclusive, knowledge, null, null, null, 101])).rows[0]["QUERY PLAN"][0]);
    const reportFootprint: Record<string, unknown>[] = [];
    function collect(node: Record<string, unknown>) {
      if (node["Relation Name"] || node["Node Type"] === "Limit") reportFootprint.push({ node: node["Node Type"], relation: node["Relation Name"], index: node["Index Name"], rows: node["Actual Rows"], loops: node["Actual Loops"] });
      for (const child of (node.Plans ?? []) as Record<string, unknown>[]) collect(child);
    }
    collect(reportPlan.Plan);
    reporting = { accountLines: 49299, pageLimit: 100, ledgerFirst: { runs: 50, p95Ms: p95(firstSamples), maxMs: Number(Math.max(...firstSamples).toFixed(3)) },
      ledgerMiddle: { runs: 50, p95Ms: p95(middleSamples), maxMs: Number(Math.max(...middleSamples).toFixed(3)), independentPrecedingBalance: "246.50" },
      statements: { runs: 50, p95Ms: p95(statementSamples), maxMs: Number(Math.max(...statementSamples).toFixed(3)), independentTies: true },
      targetMet: [firstSamples, middleSamples, statementSamples].every(values => p95(values) < 3000), queryPlan: { executionMs: reportPlan["Execution Time"], footprint: reportFootprint } };
  }
  const server = (await admin.query("SHOW server_version")).rows[0].server_version;
  console.log(JSON.stringify({ dataset: { journalLines: lineCount, openItems: ids.length, allocationEvents: 200 }, hardware: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryGiB: Number((totalmem() / 2 ** 30).toFixed(1)), node: process.version, postgres: server }, warmRead: { runs: samples.length, pageLimit: 100, p95Ms: p95(samples), maxMs: Number(Math.max(...samples).toFixed(3)), targetMet: p95(samples) < 1000 }, historicalPageRead: { runs: historySamples.length, includesHistoryTarget: true, p95Ms: p95(historySamples), targetMet: p95(historySamples) < 1000 }, applicationAndInverse: { cycles: growth.length, first25P95Ms: p95(growth.slice(0, 25)), last25P95Ms: p95(growth.slice(-25)) }, queryPlan: { executionMs: plan["Execution Time"], footprint }, reporting, publicReporting, totalSeconds: Number(((performance.now() - started) / 1000).toFixed(2)) }, null, 2));
} finally {
  const client = await admin.connect();
  const triggers = [...["journal_reversal_hold_releases", "subledger_events", "subledger_allocations", "subledger_open_items", "subledger_settlements", "subledger_sources", "subledger_counterparties"].map(table => [table, "subledger_immutable"]), ["journal_reversal_holds", "reversal_immutable"], ["journal_lines", "journal_line_immutable"], ["journal_entries", "journal_entry_immutable"], ["document_numbers", "document_number_immutable"], ["document_series", "document_series_no_delete"], ["fiscal_periods", "fiscal_period_immutable"], ["fiscal_years", "fiscal_year_immutable"], ["account_versions", "account_version_append_only"], ["accounts", "account_no_delete"], ["audit_events", "audit_append_only"]];
  try {
    await client.query("BEGIN");
    const fixture = await client.query("SELECT name FROM organizations WHERE id=$1 FOR UPDATE", [org]);
    if (fixture.rowCount && fixture.rows[0].name !== "Local subledger benchmark") throw new Error("Benchmark cleanup identity changed");
    for (const [table, trigger] of triggers) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    for (const table of ["journal_reversal_hold_releases", "journal_reversal_holds", "subledger_events", "subledger_allocations", "subledger_open_items", "subledger_settlements", "subledger_sources", "subledger_counterparties", "journal_lines", "journal_entries", "document_numbers", "document_series", "fiscal_periods", "fiscal_years", "account_versions", "accounts", "audit_events", "idempotency_results", "memberships", "legal_entities"]) await client.query(`DELETE FROM ${table} WHERE organization_id=$1`, [org]);
    await client.query("DELETE FROM organizations WHERE id=$1", [org]); await client.query("DELETE FROM auth_user WHERE id=ANY($1::text[])", [[user, owner]]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    for (const [table, trigger] of triggers) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    await client.query("COMMIT"); console.log("Removed only this run's synthetic fixture; append-only guards restored. No reset or hosted data access.");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); await admin.end(); await databasePool().end(); }
}
