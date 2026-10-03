import { test, expect, clientHeaders } from "./fixtures";
import { config } from "dotenv";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { purposeRules } from "../../domain/finance-setup";
import { statementSections } from "../../domain/accounts";
config({ path: ".env.local", quiet: true });
process.env.INITIAL_SETUP = "true";
const org = randomUUID(), password = randomBytes(24).toString("base64url"), email = `calendar-${randomUUID()}@example.invalid`, readerEmail = `calendar-reader-${randomUUID()}@example.invalid`;
let finance = "", reader = "";
test.beforeAll(async () => {
  const url = new URL(process.env.MIGRATION_DATABASE_URL ?? "");
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/kaamledger") throw new Error("Browser fixtures require the dedicated local database.");
  const { auth } = await import("../../features/identity/auth");
  finance = (await auth().api.signUpEmail({ body: { email, password, name: "Calendar finance" } })).user.id;
  reader = (await auth().api.signUpEmail({ body: { email: readerEmail, password, name: "Calendar reader" } })).user.id;
  const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  try {
    await admin.query("UPDATE auth_user SET email_verified=true WHERE id=ANY($1::text[])", [[finance, reader]]);
    await admin.query("INSERT INTO organizations(id,name) VALUES($1,'Calendar browser organization')", [org]);
    await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,'[\"organization_admin\",\"finance_manager\"]','[]','[]')", [randomUUID(), org, finance]);
  } finally { await admin.end(); }
});
test.afterAll(async () => {
  const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL }), client = await admin.connect();
  const triggers = [["document_numbers", "document_number_immutable"], ["document_series", "document_series_no_delete"], ["account_mapping_entries", "mapping_entry_immutable"], ["account_mapping_revisions", "mapping_revision_immutable"], ["fiscal_periods", "fiscal_period_immutable"], ["fiscal_years", "fiscal_year_immutable"], ["account_versions", "account_version_append_only"], ["accounts", "account_no_delete"], ["audit_events", "audit_append_only"]];
  try {
    await client.query("BEGIN");
    for (const [table, trigger] of triggers) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    for (const table of ["document_numbers", "document_series", "account_mapping_entries", "account_mapping_revisions", "fiscal_periods", "fiscal_years", "account_versions", "accounts", "audit_events", "idempotency_results", "memberships", "legal_entities"]) await client.query(`DELETE FROM ${table} WHERE organization_id=$1`, [org]);
    await client.query("DELETE FROM organizations WHERE id=$1", [org]);
    await client.query("DELETE FROM auth_user WHERE id=ANY($1::text[])", [[finance, reader]]);
    for (const [table, trigger] of triggers) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); await admin.end(); }
});

test("finance saves contiguous calendars and complete mapping versions; readers and stale edits remain safe", async ({ page, browser }) => {
  test.setTimeout(180000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/sign-in"); await page.getByLabel("Email", { exact: true }).fill(email); await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(page).toHaveURL(/\/workspace$/, { timeout: 30000 });
  const company = await page.request.post(`/api/v1/orgs/${org}/entities`, { headers: { "Idempotency-Key": randomUUID() }, data: { name: "Calendar browser company", baseCurrency: "NPR", timezone: "Asia/Kathmandu", activeModes: ["labour"], reportingProfile: "demo_accrual" } });
  expect(company.status()).toBe(201); const entity = (await company.json()).data, base = `/api/v1/orgs/${org}/entities/${entity.id}`;
  expect((await page.request.post(`/api/v1/orgs/${org}/memberships`, { headers: { "Idempotency-Key": randomUUID() }, data: { userId: reader, roleIds: ["auditor"], allowedEntityIds: [entity.id], siteIds: [], active: true } })).status()).toBe(201);
  const choices = new Map<string, { id: string; code: string; name: string }>();
  for (const [type, control] of Object.values(purposeRules)) if (!choices.has(`${type}|${control}`)) {
    const result = await page.request.post(`${base}/accounts`, { headers: { "Idempotency-Key": randomUUID() }, data: { code: `CAL-${choices.size}`, name: control === "ar" ? `Receivables-${"longname".repeat(20)}` : `${type} ${control ?? "ordinary"}`, type, normalSide: ["asset", "expense"].includes(type) ? "debit" : "credit", isControl: control !== null, controlType: control, reportMapping: { statementSection: statementSections[type], cashFlowCategory: control === "cash" ? "cash" : "unclassified" } } });
    expect(result.status()).toBe(201); choices.set(`${type}|${control}`, (await result.json()).data);
  }
  await page.reload(); await page.getByRole("link", { name: "Fiscal calendars and mappings", exact: true }).click();
  const create = page.getByRole("form", { name: "Create fiscal year", exact: true }), retained = choices.get("equity|null")!;
  await create.getByLabel("Fiscal year label", { exact: true }).fill("Configured AD year");
  await create.getByLabel("Retained earnings account", { exact: true }).click(); await page.getByRole("option", { name: `${retained.code} · ${retained.name}`, exact: true }).click();
  await create.getByLabel("Period 1 start date", { exact: true }).fill("2026-01-01"); await create.getByLabel("Period 1 exclusive end date", { exact: true }).fill("2026-07-01");
  await create.getByRole("button", { name: "Add period", exact: true }).click(); await expect(create.getByLabel("Period 2 start date", { exact: true })).toHaveValue("2026-07-01");
  await create.getByLabel("Period 2 start date", { exact: true }).fill("2026-07-02"); await create.getByLabel("Period 2 exclusive end date", { exact: true }).fill("2027-01-01");
  const gap = page.waitForResponse(r => r.url().endsWith(`${base}/fiscal-years`) && r.request().method() === "POST"); await create.getByRole("button", { name: "Save fiscal year", exact: true }).click(); expect((await gap).status()).toBe(422); await expect(create.getByRole("alert")).toBeVisible();
  await create.getByLabel("Period 2 start date", { exact: true }).fill("2026-07-01");
  const saved = page.waitForResponse(r => r.url().endsWith(`${base}/fiscal-years`) && r.request().method() === "POST"); await create.getByRole("button", { name: "Save fiscal year", exact: true }).click();
  const response = await saved; expect(response.status()).toBe(201); expect(response.headers().etag).toBe('"1"'); expect(response.headers().location).toBe(`${base}/fiscal-years`); const year = (await response.json()).data;
  expect(year.periods).toHaveLength(2); expect(year.documentSeries).toHaveLength(11); expect(year.documentSeries.every((series: { nextNumber: string }) => series.nextNumber === "1")).toBe(true);
  const request = response.request(); expect((await (await page.request.post(`${base}/fiscal-years`, { headers: { "Idempotency-Key": request.headers()["idempotency-key"] }, data: request.postDataJSON() })).json()).data).toEqual(year);
  await expect(page.getByLabel("Fiscal year Configured AD year", { exact: true })).toBeVisible();
  await page.reload(); await page.getByText("Document numbering series", { exact: true }).click(); await expect(page.getByText("journal · next 1", { exact: true })).toBeVisible();
  expect((await page.request.post(`${base}/fiscal-years`, { headers: { "Idempotency-Key": randomUUID() }, data: { ...request.postDataJSON(), fiscalYearLabel: "Overlapping year" } })).status()).toBe(409);
  expect((await page.request.get(`${base}/periods/${year.periods[0].id}`)).headers().etag).toBe('"1"');
  const mapping = page.getByRole("form", { name: "Account-purpose mappings", exact: true });
  await mapping.getByLabel("Mappings effective from", { exact: true }).fill("2026-01-01"); await mapping.getByLabel("Mapping reason", { exact: true }).fill("Reviewed initial company mappings");
  for (const [purpose, [type, control]] of Object.entries(purposeRules)) {
    const account = choices.get(`${type}|${control}`)!;
    await mapping.getByLabel(purpose.replaceAll("_", " "), { exact: true }).click(); await page.getByRole("option", { name: `${account.code} · ${account.name}`, exact: true }).click();
  }
  const mapped = page.waitForResponse(r => r.url().endsWith(`${base}/account-mappings`) && r.request().method() === "PATCH"); await mapping.getByRole("button", { name: "Save mapping version", exact: true }).click();
  const mappedResponse = await mapped; expect(mappedResponse.status()).toBe(200); expect(mappedResponse.headers().etag).toBe('"2"'); const mappedData = (await mappedResponse.json()).data;
  await expect(page.getByRole("heading", { name: "Latest version 2 · effective 2026-01-01", exact: true })).toBeVisible();
  expect((await page.request.patch(`${base}/account-mappings`, { data: mappedResponse.request().postDataJSON() })).status()).toBe(428);
  const future = { effectiveFrom: "2028-01-01", reason: "Scheduled company mappings", mappings: mappedData.latest.mappings.map(({ purpose, accountId }: { purpose: string; accountId: string }) => ({ purpose, accountId })) };
  expect((await page.request.patch(`${base}/account-mappings`, { headers: { "If-Match": '"2"' }, data: future })).status()).toBe(200);
  await mapping.getByLabel("Mappings effective from", { exact: true }).fill("2029-01-01"); await mapping.getByLabel("Mapping reason", { exact: true }).fill("Attempt based on stale version");
  await mapping.getByRole("button", { name: "Save mapping version", exact: true }).click(); await expect(mapping.getByRole("alert")).toBeVisible();
  await mapping.getByRole("button", { name: "Reload current mappings", exact: true }).click(); await expect(page.getByRole("heading", { name: "Latest version 3 · effective 2028-01-01", exact: true })).toBeVisible();
  const effective = (await (await page.request.get(`${base}/account-mappings`)).json()).data; expect(effective.current.version).toBe(2); expect(effective.latest.version).toBe(3);
  const readerContext = await browser.newContext({ extraHTTPHeaders: clientHeaders() });
  try {
    const readerPage = await readerContext.newPage(); readerPage.on("pageerror", error => errors.push(error.message));
    await readerPage.goto("http://localhost:3000/sign-in"); await readerPage.getByLabel("Email", { exact: true }).fill(readerEmail); await readerPage.getByLabel("Password", { exact: true }).fill(password); await readerPage.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(readerPage).toHaveURL(/\/workspace$/, { timeout: 30000 });
    await readerPage.getByRole("link", { name: "Fiscal calendars and mappings", exact: true }).click(); await expect(readerPage.getByText("Read-only finance setup.", { exact: false })).toBeVisible(); expect(await readerPage.getByRole("form").count()).toBe(0);
    expect((await readerPage.request.patch(`${base}/account-mappings`, { headers: { "If-Match": '"3"' }, data: { ...future, effectiveFrom: "2029-01-01" } })).status()).toBe(403);
    expect((await readerPage.request.get(`${base.replace(entity.id, randomUUID())}/periods`)).status()).toBe(404);
  } finally { await readerContext.close(); }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 360, height: 800 }); await page.screenshot({ path: ".local/screenshots/finance-setup-mobile.png", fullPage: true });
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll("main *")].filter(element => element.getBoundingClientRect().right > innerWidth + 1).slice(0, 8).map(element => ({ tag: element.tagName, id: element.id, slot: element.getAttribute("data-slot"), width: Math.round(element.getBoundingClientRect().width), right: Math.round(element.getBoundingClientRect().right) })))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mapping.getByLabel("ar", { exact: true }).click();
  const longAccount = choices.get("asset|ar")!;
  const longOption = page.getByRole("option", { name: `${longAccount.code} · ${longAccount.name}`, exact: true }); await expect(longOption).toBeVisible();
  expect(await longOption.evaluate(element => element.getBoundingClientRect().right <= innerWidth)).toBe(true);
  await page.keyboard.press("Escape"); await expect(mapping.getByLabel("ar", { exact: true })).toBeFocused();
  await page.screenshot({ path: ".local/screenshots/finance-setup-mobile-selectors.png" });
  const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  try {
    expect((await admin.query("SELECT id FROM fiscal_years WHERE organization_id=$1", [org])).rowCount).toBe(1);
    expect((await admin.query("SELECT id FROM audit_events WHERE organization_id=$1 AND action='fiscal_year.create'", [org])).rowCount).toBe(1);
    expect((await admin.query("SELECT version FROM account_mapping_revisions WHERE organization_id=$1 ORDER BY version", [org])).rows.map(row => row.version)).toEqual([2, 3]);
    expect((await admin.query("SELECT id FROM document_numbers WHERE organization_id=$1", [org])).rowCount).toBe(0);
  } finally { await admin.end(); }
  expect(errors).toEqual([]);
});
