import { test, expect } from "@playwright/test";
import { config } from "dotenv";
import { randomUUID, randomBytes } from "node:crypto";
import { Pool } from "pg";
config({ path: ".env.local", quiet: true });
process.env.INITIAL_SETUP = "true";
const email = `browser-${randomUUID()}@example.invalid`, password = randomBytes(24).toString("base64url"), orgId = randomUUID();
let userId = "";
test.beforeAll(async () => {
  if (new URL(process.env.MIGRATION_DATABASE_URL ?? "").hostname !== "127.0.0.1") throw new Error("Browser fixtures require local database.");
  const { auth } = await import("../../features/identity/auth");
  const identity = await auth().api.signUpEmail({ body: { email, password, name: "Browser operator" } }); userId = identity.user.id;
  const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await admin.query("UPDATE auth_user SET email_verified=true WHERE id=$1", [userId]);
  await admin.query("INSERT INTO organizations(id,name) VALUES($1,'Browser organization')", [orgId]);
  await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids,active) VALUES($1,$2,$3,'[\"organization_admin\"]','[]','[]',true)", [randomUUID(), orgId, userId]);
  await admin.end();
});
test.afterAll(async () => {
  const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL }), client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [orgId]);
    await client.query("ALTER TABLE audit_events DISABLE TRIGGER audit_append_only");
    for (const table of ["audit_events", "idempotency_results", "memberships", "legal_entities"]) await client.query(`DELETE FROM ${table} WHERE organization_id=$1`, [orgId]);
    await client.query("DELETE FROM organizations WHERE id=$1", [orgId]);
    await client.query("DELETE FROM auth_user WHERE id=$1", [userId]);
    await client.query("ALTER TABLE audit_events ENABLE TRIGGER audit_append_only"); await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); await admin.end(); const { databasePool } = await import("../../db/client"); await databasePool().end(); }
});
test("home, roadmap and 360px layout render without browser errors", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto("/"); await expect(page.getByRole("heading", { name: /Your work/ })).toBeVisible();
  await page.getByRole("link", { name: "Build roadmap" }).click(); await expect(page.getByRole("heading", { name: /Build the foundation/ })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 }); await page.goto("/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/home-mobile.png", fullPage: true }); expect(errors).toEqual([]);
});
test("unauthenticated workspace requires sign-in and public signup is denied", async ({ page, request }) => {
  await page.goto("/workspace"); await expect(page).toHaveURL(/\/sign-in$/);
  expect((await request.post("/api/auth/sign-up/email", { data: { email, password, name: "Intruder" } })).status()).toBe(404);
  expect((await request.get("/api/v1/me")).status()).toBe(401);
});
test("operator signs in, creates a real legal entity, survives reload and signs out", async ({ page }) => {
  test.setTimeout(90000); // Includes create, two edits, competing edit, reload and logout.
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto("/sign-in"); await page.getByLabel("Email", { exact: true }).fill(email); await page.getByLabel("Password", { exact: true }).fill(password);
  const signedIn = page.waitForResponse(r => r.url().endsWith("/api/auth/sign-in/email") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); expect((await signedIn).status()).toBe(200);
  await expect(page).toHaveURL(/\/workspace$/, { timeout: 15000 });
  await page.getByLabel("Legal entity name").fill("परीक्षण Workforce Pvt. Ltd.");
  const saved = page.waitForResponse(r => r.url().endsWith(`/orgs/${orgId}/entities`) && r.request().method() === "POST");
  await page.getByRole("button", { name: "Create entity", exact: true }).click();
  expect((await saved).status()).toBe(201);
  await expect(page.getByRole("heading", { name: "परीक्षण Workforce Pvt. Ltd." })).toBeVisible(); await page.reload();
  await expect(page.getByRole("heading", { name: "परीक्षण Workforce Pvt. Ltd." })).toBeVisible();
  const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  const entities = await admin.query("SELECT name FROM legal_entities WHERE organization_id=$1", [orgId]);
  expect(entities.rows).toEqual([{ name: "परीक्षण Workforce Pvt. Ltd." }]);
  expect((await admin.query("SELECT * FROM audit_events WHERE organization_id=$1 AND action='entity.create'", [orgId])).rowCount).toBe(1); await admin.end();
  await page.getByRole("button", { name: "Edit परीक्षण Workforce Pvt. Ltd.", exact: true }).click();
  await page.getByLabel("Company name", { exact: true }).fill("परीक्षण Workforce Updated Pvt. Ltd.");
  await page.getByLabel("Registration identifier").fill("REG-DEMO-001");
  const edited = page.waitForResponse(r => r.request().method() === "PATCH" && r.url().includes(`/orgs/${orgId}/entities/`));
  await page.getByRole("button", { name: "Save changes", exact: true }).click(); expect((await edited).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "परीक्षण Workforce Updated Pvt. Ltd." })).toBeVisible(); await page.reload();
  await page.getByRole("button", { name: "Edit परीक्षण Workforce Updated Pvt. Ltd.", exact: true }).click();
  await expect(page.getByLabel("Registration identifier")).toHaveValue("REG-DEMO-001");
  await page.getByLabel("Registration identifier").fill("");
  const entityList = await page.request.get(`/api/v1/orgs/${orgId}/entities`);
  const company = (await entityList.json()).data[0];
  expect((await page.request.patch(`/api/v1/orgs/${orgId}/entities/${company.id}`, { headers: { "If-Match": `"${company.version}"` }, data: { taxIdentifier: "TAX-DEMO-EXTERNAL" } })).status()).toBe(200);
  const stale = page.waitForResponse(r => r.request().method() === "PATCH" && r.status() === 412);
  await page.getByRole("button", { name: "Save changes", exact: true }).click(); await stale;
  await expect(page.getByRole("form", { name: "Edit company" }).getByRole("alert")).toContainText("Reload");
  await page.getByRole("button", { name: "Reload current company" }).click();
  await expect(page.getByLabel("Tax identifier")).toHaveValue("TAX-DEMO-EXTERNAL");
  await page.getByLabel("Registration identifier").fill("");
  const cleared = page.waitForResponse(r => r.request().method() === "PATCH" && r.url().includes(`/orgs/${orgId}/entities/`));
  await page.getByRole("button", { name: "Save changes", exact: true }).click(); expect((await cleared).status()).toBe(200);
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/workspace-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Sign out" }).click(); await expect(page).toHaveURL(/\/sign-in$/); expect(errors).toEqual([]);
});
