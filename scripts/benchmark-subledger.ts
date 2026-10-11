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

config({ path: ".env.local", quiet: true });
for (const name of ["MIGRATION_DATABASE_URL", "DATABASE_URL"]) {
  let url: URL;
  try { url = new URL(process.env[name] ?? ""); } catch { throw new Error(`${name} must be configured privately for the dedicated local database.`); }
  if (url.hostname !== "127.0.0.1" || url.port !== "55432" || url.pathname !== "/kaamledger") throw new Error("Benchmark writes require the dedicated local database on port 55432; hosted databases are forbidden.");
}
const org = randomUUID(), entity = randomUUID(), party = randomUUID(), user = `subledger-benchmark-${randomUUID()}`;
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
try {
  await admin.query("INSERT INTO auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Local subledger benchmark',$2,true,now(),now())", [user, `${user}@example.invalid`]);
  await admin.query("INSERT INTO organizations(id,name) VALUES($1,'Local subledger benchmark')", [org]);
  await admin.query("INSERT INTO legal_entities(id,organization_id,name,active_modes,reporting_profile,created_by) VALUES($1,$2,'Synthetic benchmark company','[\"labour\"]','demo_accrual',$3)", [entity, org, user]);
  await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,'[\"finance_manager\"]',$4,'[]')", [randomUUID(), org, user, JSON.stringify([entity])]);
  for (const [code, type, control] of [["ar", "asset", "ar"], ["deposit", "liability", "customer_deposits"], ["cash", "asset", "cash"], ["revenue", "revenue", null], ["expense", "expense", null], ["equity", "equity", null]] as const) {
    const account = await createAccount(user, org, entity, { code, name: code, type, normalSide: type === "asset" || type === "expense" ? "debit" : "credit", isControl: control !== null, controlType: control, reportMapping: { statementSection: type === "asset" ? "assets" : type === "liability" ? "liabilities" : type === "equity" ? "equity" : type === "revenue" ? "revenue" : "expenses", cashFlowCategory: control === "cash" ? "cash" : "unclassified" } }, randomUUID(), randomUUID()); accounts[code] = account.id;
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
  const server = (await admin.query("SHOW server_version")).rows[0].server_version;
  console.log(JSON.stringify({ dataset: { journalLines: lineCount, openItems: ids.length, allocationEvents: 200 }, hardware: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryGiB: Number((totalmem() / 2 ** 30).toFixed(1)), node: process.version, postgres: server }, warmRead: { runs: samples.length, pageLimit: 100, p95Ms: p95(samples), maxMs: Number(Math.max(...samples).toFixed(3)), targetMet: p95(samples) < 1000 }, historicalPageRead: { runs: historySamples.length, includesHistoryTarget: true, p95Ms: p95(historySamples), targetMet: p95(historySamples) < 1000 }, applicationAndInverse: { cycles: growth.length, first25P95Ms: p95(growth.slice(0, 25)), last25P95Ms: p95(growth.slice(-25)) }, queryPlan: { executionMs: plan["Execution Time"], footprint }, totalSeconds: Number(((performance.now() - started) / 1000).toFixed(2)) }, null, 2));
} finally {
  const client = await admin.connect();
  const triggers = [...["journal_reversal_hold_releases", "subledger_events", "subledger_allocations", "subledger_open_items", "subledger_settlements", "subledger_sources", "subledger_counterparties"].map(table => [table, "subledger_immutable"]), ["journal_reversal_holds", "reversal_immutable"], ["journal_lines", "journal_line_immutable"], ["journal_entries", "journal_entry_immutable"], ["document_numbers", "document_number_immutable"], ["document_series", "document_series_no_delete"], ["fiscal_periods", "fiscal_period_immutable"], ["fiscal_years", "fiscal_year_immutable"], ["account_versions", "account_version_append_only"], ["accounts", "account_no_delete"], ["audit_events", "audit_append_only"]];
  try {
    await client.query("BEGIN");
    const fixture = await client.query("SELECT name FROM organizations WHERE id=$1 FOR UPDATE", [org]);
    if (fixture.rowCount && fixture.rows[0].name !== "Local subledger benchmark") throw new Error("Benchmark cleanup identity changed");
    for (const [table, trigger] of triggers) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    for (const table of ["journal_reversal_hold_releases", "journal_reversal_holds", "subledger_events", "subledger_allocations", "subledger_open_items", "subledger_settlements", "subledger_sources", "subledger_counterparties", "journal_lines", "journal_entries", "document_numbers", "document_series", "fiscal_periods", "fiscal_years", "account_versions", "accounts", "audit_events", "idempotency_results", "memberships", "legal_entities"]) await client.query(`DELETE FROM ${table} WHERE organization_id=$1`, [org]);
    await client.query("DELETE FROM organizations WHERE id=$1", [org]); await client.query("DELETE FROM auth_user WHERE id=$1", [user]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    for (const [table, trigger] of triggers) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    await client.query("COMMIT"); console.log("Removed only this run's synthetic fixture; append-only guards restored. No reset or hosted data access.");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); await admin.end(); await databasePool().end(); }
}
