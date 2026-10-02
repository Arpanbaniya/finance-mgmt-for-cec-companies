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
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto("/sign-in"); await page.getByLabel("Email", { exact: true }).fill(email); await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(page).toHaveURL(/\/workspace$/);
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
  await page.screenshot({ path: "test-results/workspace-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Sign out" }).click(); await expect(page).toHaveURL(/\/sign-in$/); expect(errors).toEqual([]);
});
