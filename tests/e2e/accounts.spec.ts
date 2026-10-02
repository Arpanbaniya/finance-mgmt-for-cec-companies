import { test, expect, clientHeaders } from "./fixtures";
import { config } from "dotenv";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
config({ path: ".env.local", quiet: true });
process.env.INITIAL_SETUP = "true";
const org = randomUUID(), password = randomBytes(24).toString("base64url"), email = `accounts-finance-${randomUUID()}@example.invalid`, readerEmail = `accounts-auditor-${randomUUID()}@example.invalid`;
let finance = "", reader = "";
test.beforeAll(async () => {
  const url = new URL(process.env.MIGRATION_DATABASE_URL ?? "");
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/kaamledger") throw new Error("Browser fixtures require the dedicated local database.");
  const { auth } = await import("../../features/identity/auth");
  finance = (await auth().api.signUpEmail({ body: { email, password, name: "Account finance" } })).user.id;
  reader = (await auth().api.signUpEmail({ body: { email: readerEmail, password, name: "Account auditor" } })).user.id;
  const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  try {
    await admin.query("UPDATE auth_user SET email_verified=true WHERE id=ANY($1::text[])", [[finance, reader]]);
    await admin.query("INSERT INTO organizations(id,name) VALUES($1,'Account browser organization')", [org]);
    await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,'[\"organization_admin\",\"finance_manager\"]','[]','[]')", [randomUUID(), org, finance]);
  } finally { await admin.end(); }
});
test.afterAll(async () => {
  const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL }), client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE accounts DISABLE TRIGGER account_no_delete");
    await client.query("ALTER TABLE account_versions DISABLE TRIGGER account_version_append_only");
    await client.query("ALTER TABLE audit_events DISABLE TRIGGER audit_append_only");
    for (const table of ["account_versions", "accounts", "audit_events", "idempotency_results", "memberships", "legal_entities"]) await client.query(`DELETE FROM ${table} WHERE organization_id=$1`, [org]);
    await client.query("DELETE FROM organizations WHERE id=$1", [org]);
    await client.query("DELETE FROM auth_user WHERE id=ANY($1::text[])", [[finance, reader]]);
    await client.query("ALTER TABLE accounts ENABLE TRIGGER account_no_delete");
    await client.query("ALTER TABLE account_versions ENABLE TRIGGER account_version_append_only");
    await client.query("ALTER TABLE audit_events ENABLE TRIGGER audit_append_only");
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); await admin.end(); }
});

test("finance builds a scoped hierarchy, recovers stale edits and archives without erasing versions; auditor remains read-only", async ({ page, browser }) => {
  test.setTimeout(120000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/sign-in"); await page.getByLabel("Email", { exact: true }).fill(email); await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(page).toHaveURL(/\/workspace$/, { timeout: 30000 });
  const company = await page.request.post(`/api/v1/orgs/${org}/entities`, { headers: { "Idempotency-Key": randomUUID() }, data: { name: "Account browser company", baseCurrency: "NPR", timezone: "Asia/Kathmandu", activeModes: ["labour"], reportingProfile: "demo_accrual" } });
  expect(company.status()).toBe(201); const entity = (await company.json()).data;
  expect((await page.request.post(`/api/v1/orgs/${org}/memberships`, { headers: { "Idempotency-Key": randomUUID() }, data: { userId: reader, roleIds: ["auditor"], allowedEntityIds: [entity.id], siteIds: [], active: true } })).status()).toBe(201);
  await page.reload(); await page.getByRole("link", { name: "Chart of accounts", exact: true }).click();
  const base = `/api/v1/orgs/${org}/entities/${entity.id}/accounts`, screen = `/workspace/accounts?org=${org}&entity=${entity.id}`;
  const create = page.getByRole("form", { name: "Create account", exact: true });
  await create.getByLabel("Account code", { exact: true }).fill("assets"); await create.getByLabel("Account name", { exact: true }).fill("Asset group");
  const rootResponse = page.waitForResponse(r => r.url().endsWith(base) && r.request().method() === "POST"); await create.getByRole("button", { name: "Create account", exact: true }).click();
  const response = await rootResponse; expect(response.status()).toBe(201); const root = (await response.json()).data;
  expect(root.code).toBe("ASSETS"); expect(response.headers().etag).toBe('"1"'); expect(response.headers().location).toBe(`${base}/${root.id}`);
  await expect(page.getByRole("link", { name: "View account ASSETS", exact: true })).toBeVisible();
  await create.getByLabel("Account code", { exact: true }).fill("1001"); await create.getByLabel("Account name", { exact: true }).fill("Operating asset");
  await create.getByLabel("Parent account (optional)", { exact: true }).click(); await page.getByRole("option", { name: "ASSETS · Asset group", exact: true }).click();
  const childResponse = page.waitForResponse(r => r.url().endsWith(base) && r.request().method() === "POST"); await create.getByRole("button", { name: "Create account", exact: true }).click();
  const childResult = await childResponse; expect(childResult.status()).toBe(201); const child = (await childResult.json()).data; expect(child.parentId).toBe(root.id);
  await expect(page.getByRole("link", { name: "View account 1001", exact: true })).toBeVisible();
  await create.getByLabel("Account code", { exact: true }).fill("assets"); await create.getByLabel("Account name", { exact: true }).fill("Duplicate"); await create.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(create.getByRole("alert")).toBeVisible();
  expect((await page.request.patch(`${base}/${child.id}`, { data: { name: "Missing version" } })).status()).toBe(428);
  expect((await page.request.patch(`${base}/${child.id}`, { headers: { "If-Match": '"1"' }, data: { code: "changed" } })).status()).toBe(422);
  expect((await page.request.get(base.replace(entity.id, randomUUID()))).status()).toBe(404);
  const readContext = await browser.newContext({ extraHTTPHeaders: clientHeaders() });
  try {
    const readPage = await readContext.newPage(); readPage.on("pageerror", error => errors.push(error.message));
    await readPage.goto("http://localhost:3000/sign-in"); await readPage.getByLabel("Email", { exact: true }).fill(readerEmail); await readPage.getByLabel("Password", { exact: true }).fill(password); await readPage.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(readPage).toHaveURL(/\/workspace$/, { timeout: 30000 });
    await readPage.getByRole("link", { name: "Chart of accounts", exact: true }).click();
    await expect(readPage.getByText("Read-only account access.", { exact: false })).toBeVisible(); await expect(readPage.getByRole("form", { name: "Create account", exact: true })).toHaveCount(0);
    expect((await readPage.request.patch(`${base}/${child.id}`, { headers: { "If-Match": '"1"' }, data: { name: "Unauthorized edit" } })).status()).toBe(403);
    await page.getByRole("link", { name: "View account ASSETS", exact: true }).click();
    const archive = page.getByRole("region", { name: "Archive account", exact: true });
    await archive.getByLabel("Archive reason", { exact: true }).fill("Replace unused group"); await archive.getByRole("button", { name: "Archive account", exact: true }).click();
    const blocked = page.waitForResponse(r => r.url().endsWith(`${base}/${root.id}/archive`) && r.request().method() === "POST"); await page.getByRole("button", { name: "Confirm archive", exact: true }).click(); expect((await blocked).status()).toBe(409); await expect(archive.getByRole("alert")).toBeVisible();
    await page.getByRole("link", { name: "View account 1001", exact: true }).click();
    const edit = page.getByRole("form", { name: "Edit account", exact: true });
    expect((await page.request.patch(`${base}/${child.id}`, { headers: { "If-Match": '"1"' }, data: { name: "Updated elsewhere" } })).status()).toBe(200);
    await edit.getByLabel("Account name", { exact: true }).fill("Stale change"); await edit.getByRole("button", { name: "Save account changes", exact: true }).click(); await expect(edit.getByRole("alert")).toBeVisible();
    await edit.getByRole("button", { name: "Reload current account", exact: true }).click(); await expect(edit.getByLabel("Account name", { exact: true })).toHaveValue("Updated elsewhere");
    await edit.getByLabel("Parent account (optional)", { exact: true }).click(); await page.getByRole("option", { name: "Root account", exact: true }).click();
    await edit.getByRole("button", { name: "Save account changes", exact: true }).click(); await expect(page.getByText(/normal debit · version 3/)).toBeVisible();
    await page.reload(); expect((await (await page.request.get(`${base}/${child.id}`)).json()).data.parentId).toBeNull();
    await page.goto(`${screen}&account=${root.id}`); await archive.getByLabel("Archive reason", { exact: true }).fill("No longer required after reparenting");
    await archive.getByRole("button", { name: "Archive account", exact: true }).click(); await page.getByRole("button", { name: "Cancel archive", exact: true }).click();
    expect((await (await page.request.get(`${base}/${root.id}`)).json()).data.active).toBe(true);
    await page.setViewportSize({ width: 360, height: 800 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: ".local/screenshots/accounts-mobile.png", fullPage: true });
    await archive.getByRole("button", { name: "Archive account", exact: true }).click(); const done = page.waitForResponse(r => r.url().endsWith(`${base}/${root.id}/archive`) && r.request().method() === "POST"); await page.getByRole("button", { name: "Confirm archive", exact: true }).click();
    const archived = await done; expect(archived.status()).toBe(200); expect(archived.headers().etag).toBe('"2"');
    const request = archived.request(); const replay = await page.request.post(`${base}/${root.id}/archive`, { headers: { "If-Match": request.headers()["if-match"], "Idempotency-Key": request.headers()["idempotency-key"] }, data: request.postDataJSON() }); expect((await replay.json()).data).toEqual((await archived.json()).data);
    await expect(page.getByLabel("Account ASSETS", { exact: true }).locator('[data-slot="badge"]')).toHaveText("Archived"); await expect(archive).toHaveCount(0);
    const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
    try {
      const versions = await admin.query("SELECT version,snapshot FROM account_versions WHERE organization_id=$1 AND account_id=$2 ORDER BY version", [org, child.id]);
      expect(versions.rows.map(row => row.version)).toEqual([1, 2, 3]); expect(versions.rows[0].snapshot.parent_id).toBe(root.id); expect(versions.rows[2].snapshot.parent_id).toBeNull();
      expect((await admin.query("SELECT id FROM audit_events WHERE organization_id=$1 AND action='account.archive'", [org])).rowCount).toBe(1);
    } finally { await admin.end(); }
    expect(errors).toEqual([]);
  } finally { await readContext.close(); }
});
