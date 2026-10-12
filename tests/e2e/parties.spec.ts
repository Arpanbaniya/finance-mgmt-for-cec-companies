import { test, expect, clientHeaders } from "./fixtures";
import { config } from "dotenv";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
config({ path: ".env.local", quiet: true });
process.env.INITIAL_SETUP = "true";
const org = randomUUID(), password = randomBytes(24).toString("base64url"), email = `party-finance-${randomUUID()}@example.invalid`, readerEmail = `party-reader-${randomUUID()}@example.invalid`;
let finance = "", reader = "";
function localGuard() { const url = new URL(process.env.MIGRATION_DATABASE_URL ?? ""); if (url.hostname !== "127.0.0.1" || url.pathname !== "/kaamledger" || url.port !== (process.env.GITHUB_ACTIONS === "true" ? "5432" : "55432")) throw new Error("Party browser fixtures require the dedicated local database."); }
test.beforeAll(async () => {
  localGuard(); const { auth } = await import("../../features/identity/auth");
  finance = (await auth().api.signUpEmail({ body: { email, password, name: "Party finance" } })).user.id;
  reader = (await auth().api.signUpEmail({ body: { email: readerEmail, password, name: "Party reader" } })).user.id;
  const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  try {
    await admin.query("UPDATE auth_user SET email_verified=true WHERE id=ANY($1::text[])", [[finance, reader]]);
    await admin.query("INSERT INTO organizations(id,name) VALUES($1,'Party browser organization')", [org]);
    await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,'[\"organization_admin\",\"finance_manager\"]','[]','[]')", [randomUUID(), org, finance]);
  } finally { await admin.end(); }
});
test.afterAll(async () => {
  localGuard(); const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL }), client = await admin.connect();
  const triggers = [...["journal_reversal_hold_releases", "subledger_events", "subledger_allocations", "subledger_open_items", "subledger_settlements", "subledger_sources", "subledger_counterparties"].map(t => [t, "subledger_immutable"]),
    ["party_versions", "party_version_immutable"], ["parties", "party_no_delete"], ["journal_reversal_holds", "reversal_immutable"], ["journal_lines", "journal_line_immutable"], ["journal_entries", "journal_entry_immutable"],
    ["document_numbers", "document_number_immutable"], ["document_series", "document_series_no_delete"], ["fiscal_periods", "fiscal_period_immutable"], ["fiscal_years", "fiscal_year_immutable"], ["account_versions", "account_version_append_only"], ["accounts", "account_no_delete"], ["audit_events", "audit_append_only"]];
  try {
    await client.query("BEGIN"); for (const [table, trigger] of triggers) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    for (const table of ["journal_reversal_hold_releases", "journal_reversal_holds", "subledger_events", "subledger_allocations", "subledger_open_items", "subledger_settlements", "subledger_sources", "party_versions", "parties", "subledger_counterparties", "journal_lines", "journal_entries", "document_numbers", "document_series", "fiscal_periods", "fiscal_years", "account_versions", "accounts", "audit_events", "idempotency_results", "memberships", "legal_entities"]) await client.query(`DELETE FROM ${table} WHERE organization_id=$1`, [org]);
    await client.query("DELETE FROM organizations WHERE id=$1", [org]); await client.query("DELETE FROM auth_user WHERE id=ANY($1::text[])", [[finance, reader]]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    for (const [table, trigger] of triggers) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`); await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); await admin.end(); }
});

test("dated party statement renders real posted sources, replay, paging and mobile balances", async ({ page }) => {
  test.setTimeout(120000); localGuard();
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto("/sign-in"); await page.getByLabel("Email", { exact: true }).fill(email); await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(page).toHaveURL(/\/workspace$/, { timeout: 30000 });
  const companyResponse = await page.request.post(`/api/v1/orgs/${org}/entities`, { headers: { "Idempotency-Key": randomUUID() }, data: { name: "Statement browser company", baseCurrency: "NPR", timezone: "Asia/Kathmandu", activeModes: ["labour"], reportingProfile: "demo_accrual" } });
  expect(companyResponse.status()).toBe(201); const entity = (await companyResponse.json()).data.id;
  const base = `/api/v1/orgs/${org}/entities/${entity}/parties`;
  const created = await page.request.post(base, { headers: { "Idempotency-Key": randomUUID() }, data: { name: "Statement customer", roleSet: ["customer"], paymentTermsDays: 30 } });
  expect(created.status()).toBe(201); const party = (await created.json()).data;
  const { createAccount } = await import("../../features/accounting/accounts-service"), { createFiscalYear } = await import("../../features/accounting/setup-service");
  const accounts: Record<string, string> = {};
  for (const [code, type, control] of [["ar", "asset", "ar"], ["cash", "asset", "cash"], ["deposit", "liability", "customer_deposits"], ["revenue", "revenue", null], ["capital", "equity", null]] as const) {
    const a = await createAccount(finance, org, entity, { code, name: code, type, normalSide: type === "asset" ? "debit" : "credit", isControl: control !== null, controlType: control,
      reportMapping: { statementSection: type === "asset" ? "assets" : type === "liability" ? "liabilities" : type === "equity" ? "equity" : "revenue", cashFlowCategory: control === "cash" ? "cash" : "unclassified" } }, randomUUID(), randomUUID()); accounts[code] = a.id;
  }
  await createFiscalYear(finance, org, entity, { fiscalYearLabel: "Statement synthetic year", retainedEarningsAccountId: accounts.capital, periods: [{ startDate: "2026-01-01", endDateExclusive: "2027-01-01" }] }, randomUUID(), randomUUID());
  // Trusted local test producer only: no public source posting route or runtime grant.
  const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL }), client = await admin.connect();
  const origin = randomUUID(), capacity = randomUUID();
  try {
    const { writeSubledgerSource } = await import("../../features/accounting/subledger-service");
    await client.query("BEGIN"); await client.query("SELECT set_config('app.user_id',$1,true),set_config('app.org_id',$2,true),set_config('app.entity_id',$3,true)", [finance, org, entity]);
    await writeSubledgerSource(client, org, entity, origin, { kind: "ar_item", postingDate: "2026-01-01", documentDate: "2026-01-01", dueDate: "2026-01-31", partyId: party.id, amount: "3000.00", controlAccountId: accounts.ar, counterAccountId: accounts.revenue }, randomUUID());
    await writeSubledgerSource(client, org, entity, capacity, { kind: "ar_deposit", postingDate: "2026-01-10", documentDate: "2026-01-10", partyId: party.id, amount: "5000.00", controlAccountId: accounts.deposit, counterAccountId: accounts.cash }, randomUUID());
    const target = (await client.query("SELECT id FROM subledger_open_items WHERE source_id=$1", [origin])).rows[0].id;
    await writeSubledgerSource(client, org, entity, randomUUID(), { kind: "application", postingDate: "2026-02-01", documentDate: "2026-02-01", settlementId: capacity, openItemId: target, amount: "1000.01" }, randomUUID());
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); await admin.end(); }
  await page.goto(`/workspace/parties?org=${org}&entity=${entity}&party=${party.id}`);
  await page.getByRole("link", { name: "View party statement", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Party statement", exact: true })).toBeVisible();
  const filters = page.getByRole("form", { name: "Statement filters", exact: true });
  await filters.getByLabel("From date (optional)", { exact: true }).fill("2026-02-01"); await filters.getByLabel("As-of date (inclusive)", { exact: true }).fill("2026-02-01");
  await filters.getByRole("button", { name: "Run statement", exact: true }).click();
  const results = page.getByRole("region", { name: "Statement results", exact: true }); await expect(results).toBeVisible();
  const ar = page.getByRole("article", { name: "Receivables", exact: true }), deposit = page.getByRole("article", { name: "Customer deposits", exact: true });
  await expect(ar).toContainText("NPR 1999.99"); await expect(ar).toContainText("NPR 3000.00"); await expect(deposit).toContainText("NPR 3999.99");
  const apiResponse = await page.request.get(`${base}/${party.id}/statement?asOfDate=2026-02-01&fromDate=2026-02-01&limit=1`);
  expect(apiResponse.status()).toBe(200); const apiStatement = (await apiResponse.json()).data;
  expect(apiStatement.activity[0].effects).toMatchObject({ ar: "-1000.01", customer_deposits: "-1000.01" });
  await page.getByRole("link", { name: "Replay this statement cutoff", exact: true }).click(); await expect(page).toHaveURL(/knownAt=/);
  await expect(ar).toContainText("NPR 1999.99");
  const known = new URL(page.url()).searchParams.get("knownAt")!;
  await page.goto(`/workspace/party-statement?${new URLSearchParams({ org, entity, party: party.id, asOfDate: "2026-02-01", knownAt: known, limit: "1" })}`);
  await expect(page.getByRole("region", { name: "Statement activity", exact: true }).getByRole("listitem")).toHaveCount(1);
  await page.getByRole("link", { name: "Next statement page", exact: true }).click();
  // Paging preserves page size, the original report and its knowledge cutoff.
  await expect(page).toHaveURL(/cursor=/); await expect(ar).toContainText("NPR 1999.99");
  expect(new URL(page.url()).searchParams.get("knownAt")).toBe(known);
  expect(new URL(page.url()).searchParams.get("limit")).toBe("1");
  await page.setViewportSize({ width: 360, height: 800 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: ".local/screenshots/party-statement-mobile.png", fullPage: true });
  await page.goto(`/workspace/party-statement?org=${org}&entity=${entity}&party=${party.id}&asOfDate=2026-02-01&fromDate=2026-03-01`);
  await expect(page.getByRole("alert").filter({ hasText: "Check statement filters" })).toBeVisible(); expect(errors).toEqual([]);
});
test("finance manages party terms, conflict reload and safe archival while readers cannot write", async ({ page, browser }) => {
  test.setTimeout(120000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/sign-in"); await page.getByLabel("Email", { exact: true }).fill(email); await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(page).toHaveURL(/\/workspace$/, { timeout: 30000 });
  const company = await page.request.post(`/api/v1/orgs/${org}/entities`, { headers: { "Idempotency-Key": randomUUID() }, data: { name: "Party browser company", baseCurrency: "NPR", timezone: "Asia/Kathmandu", activeModes: ["labour"], reportingProfile: "demo_accrual" } });
  expect(company.status()).toBe(201); const entity = (await company.json()).data;
  expect((await page.request.post(`/api/v1/orgs/${org}/memberships`, { headers: { "Idempotency-Key": randomUUID() }, data: { userId: reader, roleIds: ["auditor"], allowedEntityIds: [entity.id], siteIds: [], active: true } })).status()).toBe(201);
  await page.reload(); await page.getByRole("link", { name: "Customers and suppliers", exact: true }).and(page.locator(`a[href$="entity=${entity.id}"]`)).click();
  const base = `/api/v1/orgs/${org}/entities/${entity.id}/parties`, screen = `/workspace/parties?org=${org}&entity=${entity.id}`;
  const form = page.getByRole("form", { name: "Create party", exact: true });
  await form.getByLabel("Party name", { exact: true }).fill("  Example   both-role party  "); await form.getByLabel("Supplier", { exact: true }).check();
  await form.getByLabel("Contact (optional)", { exact: true }).fill("Example contact"); await form.getByLabel("Payment terms (days)", { exact: true }).fill("30");
  await form.getByLabel("Customer credit limit (NPR, optional)", { exact: true }).fill("999999999999999999.99");
  const created = page.waitForResponse(r => r.url().endsWith(base) && r.request().method() === "POST"); await form.getByRole("button", { name: "Create party", exact: true }).click();
  const response = await created; expect(response.status()).toBe(201); const party = (await response.json()).data;
  expect(party).toMatchObject({ name: "Example both-role party", roleSet: ["customer", "supplier"], creditLimit: "999999999999999999.99", paymentTermsDays: 30 });
  expect(response.headers().etag).toBe('"1"'); expect(response.headers().location).toBe(`${base}/${party.id}`); expect(response.headers()["cache-control"]).toBe("private, no-store");
  await expect(page.getByRole("form", { name: "Edit party", exact: true })).toBeVisible();
  expect((await page.request.post(base, { headers: { "Idempotency-Key": randomUUID() }, data: { name: party.name.toUpperCase(), roleSet: ["customer"] } })).status()).toBe(409);
  expect((await page.request.patch(`${base}/${party.id}`, { data: { name: "Missing version" } })).status()).toBe(428);
  expect((await page.request.patch(`${base}/${party.id}`, { headers: { "If-Match": '"1"' }, data: { active: false } })).status()).toBe(422);
  expect((await page.request.get(`${base}?limit=101`)).status()).toBe(422);
  expect((await page.request.post(base, { headers: { Origin: "https://not-allowed.example.invalid", "Idempotency-Key": randomUUID() }, data: { name: "Wrong origin", roleSet: ["supplier"] } })).status()).toBe(403);
  expect((await page.request.get(base.replace(entity.id, randomUUID()))).status()).toBe(404);
  const edit = page.getByRole("form", { name: "Edit party", exact: true });
  expect((await page.request.patch(`${base}/${party.id}`, { headers: { "If-Match": '"1"' }, data: { name: "Updated elsewhere" } })).status()).toBe(200);
  await edit.getByLabel("Party name", { exact: true }).fill("Stale edit"); await edit.getByRole("button", { name: "Save party", exact: true }).click(); await expect(edit.getByRole("alert")).toBeVisible();
  await edit.getByRole("button", { name: "Reload current party", exact: true }).click(); await expect(edit.getByLabel("Party name", { exact: true })).toHaveValue("Updated elsewhere");
  await edit.getByLabel("Payment terms (days)", { exact: true }).fill("0"); await edit.getByLabel("Customer credit limit (NPR, optional)", { exact: true }).fill(""); await edit.getByLabel("Contact (optional)", { exact: true }).fill("");
  await edit.getByRole("button", { name: "Save party", exact: true }).click(); await expect(page.getByText("customer / supplier · version 3", { exact: true })).toBeVisible();
  await page.reload(); expect((await (await page.request.get(`${base}/${party.id}`)).json()).data).toMatchObject({ creditLimit: null, contact: null, paymentTermsDays: 0 });
  const statementURL = `${base}/${party.id}/statement?asOfDate=2026-02-01`;
  const statementResponse = await page.request.get(statementURL); expect(statementResponse.status()).toBe(200);
  expect(statementResponse.headers()["cache-control"]).toBe("private, no-store");
  const emptyStatement = (await statementResponse.json()).data;
  expect(emptyStatement.party).toMatchObject({ id: party.id, name: "Updated elsewhere", version: 3 });
  expect(emptyStatement.balances).toHaveLength(4); expect(emptyStatement.balances.every((b: { closing: string }) => b.closing === "0.00")).toBe(true);
  expect((await page.request.get(`${statementURL}&asOfDate=2026-03-01`)).status()).toBe(400);
  expect((await page.request.get(`${statementURL}&limit=101`)).status()).toBe(422);
  expect((await page.request.get(statementURL.replace(party.id, randomUUID()))).status()).toBe(404);
  const readContext = await browser.newContext({ extraHTTPHeaders: clientHeaders() });
  try {
    const readPage = await readContext.newPage(); readPage.on("pageerror", error => errors.push(error.message));
    await readPage.goto("http://localhost:3000/sign-in"); await readPage.getByLabel("Email", { exact: true }).fill(readerEmail); await readPage.getByLabel("Password", { exact: true }).fill(password); await readPage.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(readPage).toHaveURL(/\/workspace$/, { timeout: 30000 });
    await readPage.getByRole("link", { name: "Customers and suppliers", exact: true }).click(); await expect(readPage.getByText("Read-only party access.", { exact: false })).toBeVisible();
    await expect(readPage.getByRole("form")).toHaveCount(0); expect((await readPage.request.patch(`${base}/${party.id}`, { headers: { "If-Match": '"3"' }, data: { name: "Forbidden" } })).status()).toBe(403);
    expect((await readPage.request.get(statementURL)).status()).toBe(200);
    const member = (await (await page.request.get(`/api/v1/orgs/${org}/memberships?limit=100`)).json()).data.find((m: { userId: string }) => m.userId === reader);
    expect((await page.request.patch(`/api/v1/orgs/${org}/memberships/${member.id}`, { headers: { "If-Match": `"${member.version}"` }, data: { userId: reader, roleIds: ["owner"], allowedEntityIds: [entity.id], siteIds: [], active: true } })).status()).toBe(200);
    expect((await readPage.request.get(base)).status()).toBe(403);
    expect((await readPage.request.get(statementURL)).status()).toBe(403);
    await readPage.goto(`http://localhost:3000${screen}`); await expect(readPage.getByRole("heading", { name: "Customers and suppliers", exact: true })).toHaveCount(0);
    const archive = page.getByRole("region", { name: "Archive party", exact: true }); await archive.getByLabel("Archive reason", { exact: true }).fill("Retired company contact");
    await archive.getByRole("button", { name: "Archive party", exact: true }).click(); await page.getByRole("button", { name: "Cancel archive", exact: true }).click(); expect((await (await page.request.get(`${base}/${party.id}`)).json()).data.active).toBe(true);
    await page.setViewportSize({ width: 360, height: 800 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: ".local/screenshots/parties-mobile.png", fullPage: true });
    await archive.getByRole("button", { name: "Archive party", exact: true }).click(); const done = page.waitForResponse(r => r.url().endsWith(`${base}/${party.id}/archive`) && r.request().method() === "POST"); await page.getByRole("button", { name: "Confirm archive", exact: true }).click();
    const archived = await done; expect(archived.status()).toBe(200); expect(archived.headers().etag).toBe('"4"');
    expect((await (await page.request.get(statementURL)).json()).data.party).toMatchObject({ active: false, version: 4 });
    const request = archived.request(); const replay = await page.request.post(`${base}/${party.id}/archive`, { headers: { "If-Match": request.headers()["if-match"], "Idempotency-Key": request.headers()["idempotency-key"] }, data: request.postDataJSON() }); expect((await replay.json()).data).toEqual((await archived.json()).data);
    await expect(page.getByLabel("Party Updated elsewhere", { exact: true }).locator('[data-slot="badge"]')).toHaveText("Archived"); await expect(archive).toHaveCount(0);
    const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
    try {
      const versions = (await admin.query("SELECT version,snapshot FROM party_versions WHERE party_id=$1 ORDER BY version", [party.id])).rows;
      expect(versions.map(row => row.version)).toEqual([1, 2, 3, 4]); expect(versions[0].snapshot.credit_limit).toBe("999999999999999999.99"); expect(versions[2].snapshot.credit_limit).toBeNull();
      expect((await admin.query("SELECT id FROM audit_events WHERE organization_id=$1 AND action='party.archive'", [org])).rowCount).toBe(1);
    } finally { await admin.end(); }
    expect(errors).toEqual([]);
  } finally { await readContext.close(); }
});
