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
  const triggers = [["party_versions", "party_version_immutable"], ["parties", "party_no_delete"], ["subledger_counterparties", "subledger_immutable"], ["audit_events", "audit_append_only"]];
  try {
    await client.query("BEGIN"); for (const [table, trigger] of triggers) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    for (const table of ["party_versions", "parties", "subledger_counterparties", "audit_events", "idempotency_results", "memberships", "legal_entities"]) await client.query(`DELETE FROM ${table} WHERE organization_id=$1`, [org]);
    await client.query("DELETE FROM organizations WHERE id=$1", [org]); await client.query("DELETE FROM auth_user WHERE id=ANY($1::text[])", [[finance, reader]]);
    for (const [table, trigger] of triggers) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`); await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); await admin.end(); }
});
test("finance manages party terms, conflict reload and safe archival while readers cannot write", async ({ page, browser }) => {
  test.setTimeout(120000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/sign-in"); await page.getByLabel("Email", { exact: true }).fill(email); await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(page).toHaveURL(/\/workspace$/, { timeout: 30000 });
  const company = await page.request.post(`/api/v1/orgs/${org}/entities`, { headers: { "Idempotency-Key": randomUUID() }, data: { name: "Party browser company", baseCurrency: "NPR", timezone: "Asia/Kathmandu", activeModes: ["labour"], reportingProfile: "demo_accrual" } });
  expect(company.status()).toBe(201); const entity = (await company.json()).data;
  expect((await page.request.post(`/api/v1/orgs/${org}/memberships`, { headers: { "Idempotency-Key": randomUUID() }, data: { userId: reader, roleIds: ["auditor"], allowedEntityIds: [entity.id], siteIds: [], active: true } })).status()).toBe(201);
  await page.reload(); await page.getByRole("link", { name: "Customers and suppliers", exact: true }).click();
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
  const readContext = await browser.newContext({ extraHTTPHeaders: clientHeaders() });
  try {
    const readPage = await readContext.newPage(); readPage.on("pageerror", error => errors.push(error.message));
    await readPage.goto("http://localhost:3000/sign-in"); await readPage.getByLabel("Email", { exact: true }).fill(readerEmail); await readPage.getByLabel("Password", { exact: true }).fill(password); await readPage.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(readPage).toHaveURL(/\/workspace$/, { timeout: 30000 });
    await readPage.getByRole("link", { name: "Customers and suppliers", exact: true }).click(); await expect(readPage.getByText("Read-only party access.", { exact: false })).toBeVisible();
    await expect(readPage.getByRole("form")).toHaveCount(0); expect((await readPage.request.patch(`${base}/${party.id}`, { headers: { "If-Match": '"3"' }, data: { name: "Forbidden" } })).status()).toBe(403);
    const member = (await (await page.request.get(`/api/v1/orgs/${org}/memberships?limit=100`)).json()).data.find((m: { userId: string }) => m.userId === reader);
    expect((await page.request.patch(`/api/v1/orgs/${org}/memberships/${member.id}`, { headers: { "If-Match": `"${member.version}"` }, data: { userId: reader, roleIds: ["owner"], allowedEntityIds: [entity.id], siteIds: [], active: true } })).status()).toBe(200);
    expect((await readPage.request.get(base)).status()).toBe(403);
    await readPage.goto(`http://localhost:3000${screen}`); await expect(readPage.getByRole("heading", { name: "Customers and suppliers", exact: true })).toHaveCount(0);
    const archive = page.getByRole("region", { name: "Archive party", exact: true }); await archive.getByLabel("Archive reason", { exact: true }).fill("Retired company contact");
    await archive.getByRole("button", { name: "Archive party", exact: true }).click(); await page.getByRole("button", { name: "Cancel archive", exact: true }).click(); expect((await (await page.request.get(`${base}/${party.id}`)).json()).data.active).toBe(true);
    await page.setViewportSize({ width: 360, height: 800 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: ".local/screenshots/parties-mobile.png", fullPage: true });
    await archive.getByRole("button", { name: "Archive party", exact: true }).click(); const done = page.waitForResponse(r => r.url().endsWith(`${base}/${party.id}/archive`) && r.request().method() === "POST"); await page.getByRole("button", { name: "Confirm archive", exact: true }).click();
    const archived = await done; expect(archived.status()).toBe(200); expect(archived.headers().etag).toBe('"4"');
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
