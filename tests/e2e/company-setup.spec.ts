import { test, expect } from "@playwright/test";
import { config } from "dotenv";
import { randomUUID, randomBytes } from "node:crypto";
import { Pool } from "pg";
config({ path: ".env.local", quiet: true });
process.env.INITIAL_SETUP = "true";
const email = `browser-${randomUUID()}@example.invalid`, password = randomBytes(24).toString("base64url"), orgId = randomUUID();
const memberEmail = `member-${randomUUID()}@example.invalid`;
let userId = "", memberUserId = "";
test.beforeAll(async () => {
  if (new URL(process.env.MIGRATION_DATABASE_URL ?? "").hostname !== "127.0.0.1") throw new Error("Browser fixtures require local database.");
  const { auth } = await import("../../features/identity/auth");
  const identity = await auth().api.signUpEmail({ body: { email, password, name: "Browser operator" } }); userId = identity.user.id;
  const memberIdentity = await auth().api.signUpEmail({ body: { email: memberEmail, password, name: "Browser member" } }); memberUserId = memberIdentity.user.id;
  const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await admin.query("UPDATE auth_user SET email_verified=true WHERE id=ANY($1::text[])", [[userId, memberUserId]]);
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
    await client.query("DELETE FROM auth_user WHERE id=ANY($1::text[])", [[userId, memberUserId]]);
    await client.query("ALTER TABLE audit_events ENABLE TRIGGER audit_append_only"); await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); await admin.end(); const { databasePool } = await import("../../db/client"); await databasePool().end(); }
});

test("administrator grants, updates, resolves stale access and revokes a real membership", async ({ page, playwright }) => {
  test.setTimeout(90000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto("/sign-in"); await page.getByLabel("Email", { exact: true }).fill(email); await page.getByLabel("Password", { exact: true }).fill(password);
  const signedIn = page.waitForResponse(r => r.url().endsWith("/api/auth/sign-in/email") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); expect((await signedIn).status()).toBe(200);
  await expect(page).toHaveURL(/\/workspace$/, { timeout: 15000 });
  const entityResponse = await page.request.post(`/api/v1/orgs/${orgId}/entities`, { headers: { "Idempotency-Key": randomUUID() }, data: { name: "Membership test company", baseCurrency: "NPR", timezone: "Asia/Kathmandu", activeModes: ["labour"], reportingProfile: "demo_accrual" } });
  expect(entityResponse.status()).toBe(201); const entity = (await entityResponse.json()).data;
  await page.getByRole("link", { name: "Manage memberships" }).click();
  await expect(page).toHaveURL(/\/workspace\/members\?org=/, { timeout: 30000 });
  await expect(page.getByRole("heading", { name: "Membership administration", exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: `Edit membership ${userId}`, exact: true })).toBeDisabled();
  const form = page.getByRole("form", { name: "Membership access" });
  await form.getByLabel("Verified user ID").fill("missing-identity");
  const missing = page.waitForResponse(r => r.url().endsWith(`/orgs/${orgId}/memberships`) && r.request().method() === "POST");
  await form.getByRole("button", { name: "Create membership", exact: true }).click();
  const missingResponse = await missing; expect(missingResponse.status()).toBe(422); expect((await missingResponse.json()).error.code).toBe("INVALID_IDENTITY");
  await expect(form.getByRole("alert")).toContainText("existing verified identity");
  await form.getByLabel("Verified user ID").fill(memberUserId);
  await form.getByRole("switch", { name: "Membership test company", exact: true }).check();
  const created = page.waitForResponse(r => r.url().endsWith(`/orgs/${orgId}/memberships`) && r.request().method() === "POST");
  await form.getByRole("button", { name: "Create membership", exact: true }).click();
  const createdResponse = await created; expect(createdResponse.status()).toBe(201); const member = (await createdResponse.json()).data;
  await expect(page.getByText(memberUserId, { exact: true })).toBeVisible(); await page.reload();
  const memberClient = await playwright.request.newContext({ baseURL: "http://localhost:3000" });
  try {
    expect((await memberClient.post("/api/auth/sign-in/email", { data: { email: memberEmail, password } })).status()).toBe(200);
    expect((await memberClient.get(`/api/v1/orgs/${orgId}/memberships`)).status()).toBe(403);
    expect((await memberClient.get(`/workspace/members?org=${orgId}`)).status()).toBe(404);
    const granted = await memberClient.get(`/api/v1/orgs/${orgId}/entities`); expect(granted.status()).toBe(200); expect((await granted.json()).data.map((e: { id: string }) => e.id)).toEqual([entity.id]);
    await page.getByRole("button", { name: `Edit membership ${memberUserId}`, exact: true }).click();
    await form.getByRole("switch", { name: "Owner", exact: true }).check(); await form.getByRole("switch", { name: "Accountant", exact: true }).uncheck();
    const updated = page.waitForResponse(r => r.url().endsWith(`/memberships/${member.id}`) && r.request().method() === "PATCH");
    await form.getByRole("button", { name: "Save access", exact: true }).click(); expect((await updated).status()).toBe(200);
    await expect(page.getByRole("status")).toContainText("Membership saved");
    await page.getByRole("button", { name: `Edit membership ${memberUserId}`, exact: true }).click();
    await expect(form.getByRole("switch", { name: "Owner", exact: true })).toBeChecked();
    expect((await page.request.patch(`/api/v1/orgs/${orgId}/memberships/${member.id}`, { headers: { "If-Match": '"2"' }, data: { userId: memberUserId, roleIds: ["finance_manager"], allowedEntityIds: [entity.id], siteIds: [], active: true } })).status()).toBe(200);
    await form.getByRole("switch", { name: "Auditor", exact: true }).check();
    const stale = page.waitForResponse(r => r.url().endsWith(`/memberships/${member.id}`) && r.status() === 412);
    await form.getByRole("button", { name: "Save access", exact: true }).click(); await stale;
    await expect(form.getByRole("alert")).toContainText("Reload");
    await form.getByRole("button", { name: "Reload current memberships" }).click();
    await expect(form.getByRole("switch", { name: "Finance manager", exact: true })).toBeChecked();
    await expect(form.getByRole("switch", { name: "Owner", exact: true })).not.toBeChecked();
    await form.getByRole("switch", { name: "Membership active", exact: true }).uncheck();
    await form.getByRole("button", { name: "Save access", exact: true }).click();
    await page.getByRole("button", { name: "Keep access", exact: true }).click();
    expect((await memberClient.get(`/api/v1/orgs/${orgId}/entities`)).status()).toBe(200);
    await form.getByRole("button", { name: "Save access", exact: true }).click();
    const revoked = page.waitForResponse(r => r.url().endsWith(`/memberships/${member.id}`) && r.request().method() === "PATCH");
    await page.getByRole("button", { name: "Revoke access", exact: true }).click(); expect((await revoked).status()).toBe(200);
    expect((await memberClient.get(`/api/v1/orgs/${orgId}/entities`)).status()).toBe(404);
    expect((await memberClient.get("/api/v1/me")).status()).toBe(200); // Session persists; organization access does not.
    const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
    try {
      expect((await admin.query("SELECT active,version,roles FROM memberships WHERE id=$1", [member.id])).rows).toEqual([{ active: false, version: 4, roles: ["finance_manager"] }]);
      expect((await admin.query("SELECT * FROM audit_events WHERE target_id=$1 AND action='membership.create'", [member.id])).rowCount).toBe(1);
      expect((await admin.query("SELECT * FROM audit_events WHERE target_id=$1 AND action='membership.update'", [member.id])).rowCount).toBe(3);
    } finally { await admin.end(); }
    await page.setViewportSize({ width: 360, height: 800 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/memberships-mobile.png", fullPage: true }); expect(errors).toEqual([]);
  } finally { await memberClient.dispose(); }
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
  const savedResponse = await saved; expect(savedResponse.status()).toBe(201); const savedCompany = (await savedResponse.json()).data;
  await expect(page.getByRole("heading", { name: "परीक्षण Workforce Pvt. Ltd." })).toBeVisible(); await page.reload();
  await expect(page.getByRole("heading", { name: "परीक्षण Workforce Pvt. Ltd." })).toBeVisible();
  const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  const entities = await admin.query("SELECT name FROM legal_entities WHERE organization_id=$1 AND name=$2", [orgId, "परीक्षण Workforce Pvt. Ltd."]);
  expect(entities.rows).toEqual([{ name: "परीक्षण Workforce Pvt. Ltd." }]);
  expect((await admin.query("SELECT * FROM audit_events WHERE organization_id=$1 AND target_id=$2 AND action='entity.create'", [orgId, savedCompany.id])).rowCount).toBe(1); await admin.end();
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
  const company = (await entityList.json()).data.find((e: { name: string }) => e.name === "परीक्षण Workforce Updated Pvt. Ltd.");
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
