import { test, expect } from "./fixtures";
import { config } from "dotenv";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
config({ path: ".env.local", quiet: true });
process.env.INITIAL_SETUP = "true";
const org = randomUUID(), password = randomBytes(24).toString("base64url"), email = `rule-finance-${randomUUID()}@example.invalid`, readerEmail = `rule-reader-${randomUUID()}@example.invalid`;
let finance = "", reader = "";
function guard() { for (const connection of [process.env.MIGRATION_DATABASE_URL, process.env.DATABASE_URL]) { const url = new URL(connection ?? ""); if (url.hostname !== "127.0.0.1" || url.pathname !== "/kaamledger" || url.port !== (process.env.GITHUB_ACTIONS === "true" ? "5432" : "55432")) throw new Error("Rule browser fixtures require the dedicated local database."); } }
test.beforeAll(async () => {
  guard(); const { auth } = await import("../../features/identity/auth");
  finance = (await auth().api.signUpEmail({ body: { email, password, name: "Rule finance" } })).user.id;
  reader = (await auth().api.signUpEmail({ body: { email: readerEmail, password, name: "Rule reader" } })).user.id;
  const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  try {
    await admin.query("UPDATE auth_user SET email_verified=true WHERE id=ANY($1::text[])", [[finance, reader]]);
    await admin.query("INSERT INTO organizations(id,name) VALUES($1,'Rule browser organization')", [org]);
    await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,'[\"organization_admin\",\"finance_manager\"]','[]','[]')", [randomUUID(), org, finance]);
  } finally { await admin.end(); }
});
test.afterAll(async () => {
  guard(); const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL }), client = await admin.connect();
  try {
    await client.query("BEGIN"); await client.query("ALTER TABLE rule_versions DISABLE TRIGGER rule_immutable"); await client.query("ALTER TABLE audit_events DISABLE TRIGGER audit_append_only");
    for (const table of ["rule_versions", "audit_events", "idempotency_results", "memberships", "legal_entities"]) await client.query(`DELETE FROM ${table} WHERE organization_id=$1`, [org]);
    await client.query("DELETE FROM organizations WHERE id=$1", [org]); await client.query("DELETE FROM auth_user WHERE id=ANY($1::text[])", [[finance, reader]]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE"); await client.query("ALTER TABLE rule_versions ENABLE TRIGGER rule_immutable"); await client.query("ALTER TABLE audit_events ENABLE TRIGGER audit_append_only"); await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); await admin.end(); }
});
test("typed rule draft survives reload, shows exact preview, rejects escalation and respects current membership", async ({ page }) => {
  test.setTimeout(120000); guard(); const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/sign-in"); await page.getByLabel("Email", { exact: true }).fill(email); await page.getByLabel("Password", { exact: true }).fill(password); await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/workspace$/, { timeout: 30000 });
  const companyResponse = await page.request.post(`/api/v1/orgs/${org}/entities`, { headers: { "Idempotency-Key": randomUUID() }, data: { name: "Synthetic rule browser company", baseCurrency: "NPR", timezone: "Asia/Kathmandu", activeModes: ["labour"], reportingProfile: "demo_accrual" } });
  expect(companyResponse.status()).toBe(201); const entity = (await companyResponse.json()).data.id, base = `/api/v1/orgs/${org}/entities/${entity}/rule-versions`;
  await page.reload(); await page.getByRole("link", { name: "Rule drafts", exact: true }).click(); await expect(page.getByRole("heading", { name: "Rule drafts", exact: true })).toBeVisible();
  await page.getByLabel("Tax code", { exact: true }).fill("DEMO_OUTPUT"); await page.getByLabel("Effective from (AD)", { exact: true }).fill("2026-01-01"); await page.getByLabel("Exclusive end date (AD, optional)", { exact: true }).fill("2027-01-01");
  await page.getByLabel("Rate (%)", { exact: true }).fill("101"); await page.getByLabel("Source title", { exact: true }).fill("Synthetic browser fixture, not law"); await page.getByLabel("Source URL", { exact: true }).fill("https://example.invalid/tax-fixture"); await page.getByLabel("Source section", { exact: true }).fill("Fixture A"); await page.getByLabel("Source SHA-256", { exact: true }).fill("c".repeat(64));
  const invalid = page.waitForResponse(response => response.url().endsWith("/rule-versions") && response.request().method() === "POST"); await page.getByRole("button", { name: "Create draft", exact: true }).click(); expect((await invalid).status()).toBe(422); await expect(page.locator("form").getByRole("alert")).toContainText("Percentage must");
  await page.getByLabel("Rate (%)", { exact: true }).fill("10"); const created = page.waitForResponse(response => response.url().endsWith("/rule-versions") && response.request().method() === "POST"); await page.getByRole("button", { name: "Create draft", exact: true }).click();
  const response = await created; expect(response.status()).toBe(201); expect(response.headers().etag).toBe('"1"'); const draft = (await response.json()).data;
  expect(response.headers().location).toBe(`${base}/${draft.id}`); await expect(page).toHaveURL(new RegExp(`rule=${draft.id}`));
  const selected = page.getByLabel("Selected rule draft", { exact: true }); await expect(selected).toContainText("Synthetic demo only — not law"); await expect(selected).toContainText("net 100.00, tax 10.00, gross 110.00"); await page.reload(); await expect(selected).toContainText(draft.contentHash);
  const replay = await page.request.post(base, { headers: { "Idempotency-Key": response.request().headers()["idempotency-key"] }, data: response.request().postDataJSON() }); expect(replay.status()).toBe(201); expect((await replay.json()).data).toEqual(draft);
  expect((await page.request.post(base, { data: response.request().postDataJSON() })).status()).toBe(400);
  expect((await page.request.post(base, { headers: { "Idempotency-Key": randomUUID() }, data: { ...response.request().postDataJSON(), status: "active" } })).status()).toBe(422);
  expect((await page.request.get(`${base}/${randomUUID()}`)).status()).toBe(404);
  expect((await page.request.post(`${base}/${draft.id}/activate`, { data: {} })).status()).toBe(404);
  await page.setViewportSize({ width: 360, height: 800 }); await expect(selected).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: ".local/screenshots/rule-drafts-mobile.png", fullPage: true }); expect(errors).toEqual([]);
  const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  try {
    expect((await admin.query("SELECT id FROM rule_versions WHERE organization_id=$1", [org])).rowCount).toBe(1); expect((await admin.query("SELECT id FROM audit_events WHERE target_id=$1 AND action='rule.create'", [draft.id])).rowCount).toBe(1);
    await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,'[\"accountant\"]',$4,'[]')", [randomUUID(), org, reader, JSON.stringify([entity])]);
    await page.getByRole("link", { name: "Back to workspace", exact: true }).click(); await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByLabel("Email", { exact: true }).fill(readerEmail); await page.getByLabel("Password", { exact: true }).fill(password); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(page).toHaveURL(/\/workspace$/);
    await page.getByRole("link", { name: "Rule drafts", exact: true }).click(); await expect(page.getByText("Read-only rule access.", { exact: false })).toBeVisible(); await expect(page.getByRole("button", { name: "Create draft", exact: true })).toHaveCount(0);
    expect((await page.request.post(base, { headers: { "Idempotency-Key": randomUUID() }, data: response.request().postDataJSON() })).status()).toBe(403);
    expect((await page.request.get(`${base}/${draft.id}`)).status()).toBe(200);
    await admin.query("UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2", [org, reader]); expect((await page.request.get(`${base}/${draft.id}`)).status()).toBe(404);
    await page.reload(); await expect(page.getByRole("heading", { name: "Rule drafts", exact: true })).toHaveCount(0); expect(errors).toEqual([]);
  } finally { await admin.end(); }
});
