import { test, expect, clientHeaders } from "./fixtures";
import { config } from "dotenv";
import { randomUUID, randomBytes } from "node:crypto";
import { Pool } from "pg";
config({ path: ".env.local", quiet: true });
process.env.INITIAL_SETUP = "true";
const org = randomUUID(), password = randomBytes(24).toString("base64url"), makerEmail = `policy-maker-${randomUUID()}@example.invalid`, reviewerEmail = `policy-reviewer-${randomUUID()}@example.invalid`, financeEmail = `policy-finance-${randomUUID()}@example.invalid`;
let maker = "", reviewer = "", finance = "";
test.beforeAll(async () => {
  const url = new URL(process.env.MIGRATION_DATABASE_URL ?? ""); if (url.hostname !== "127.0.0.1" || url.pathname !== "/kaamledger") throw new Error("Browser fixtures require the dedicated local database.");
  const { auth } = await import("../../features/identity/auth");
  maker = (await auth().api.signUpEmail({ body: { email: makerEmail, password, name: "Policy maker" } })).user.id;
  reviewer = (await auth().api.signUpEmail({ body: { email: reviewerEmail, password, name: "Policy reviewer" } })).user.id;
  finance = (await auth().api.signUpEmail({ body: { email: financeEmail, password, name: "Finance only" } })).user.id;
  const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  try {
    await admin.query("UPDATE auth_user SET email_verified=true WHERE id=ANY($1::text[])", [[maker, reviewer, finance]]);
    await admin.query("INSERT INTO organizations(id,name) VALUES($1,'Approval browser organization')", [org]);
    await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,'[\"organization_admin\"]','[]','[]')", [randomUUID(), org, maker]);
  } finally { await admin.end(); }
});
test.afterAll(async () => {
  const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL }), client = await admin.connect();
  try {
    await client.query("BEGIN"); await client.query("ALTER TABLE audit_events DISABLE TRIGGER audit_append_only"); await client.query("ALTER TABLE approval_policies DISABLE TRIGGER approval_policy_no_delete");
    for (const table of ["audit_events", "idempotency_results", "approval_policies", "memberships", "legal_entities"]) await client.query(`DELETE FROM ${table} WHERE organization_id=$1`, [org]);
    await client.query("DELETE FROM organizations WHERE id=$1", [org]); await client.query("DELETE FROM auth_user WHERE id=ANY($1::text[])", [[maker, reviewer, finance]]);
    await client.query("ALTER TABLE approval_policies ENABLE TRIGGER approval_policy_no_delete"); await client.query("ALTER TABLE audit_events ENABLE TRIGGER audit_append_only"); await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); await admin.end(); }
});

test("maker saves exact ranges; independent reviewer activates, resolves stale state and reads immutable scoped audit", async ({ page, browser, playwright }) => {
  test.setTimeout(180000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/sign-in"); await page.getByLabel("Email", { exact: true }).fill(makerEmail); await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(page).toHaveURL(/\/workspace$/, { timeout: 30000 });
  const entityResponse = await page.request.post(`/api/v1/orgs/${org}/entities`, { headers: { "Idempotency-Key": randomUUID() }, data: { name: "Independent approval company", baseCurrency: "NPR", timezone: "Asia/Kathmandu", activeModes: ["labour"], reportingProfile: "demo_accrual" } });
  expect(entityResponse.status()).toBe(201); const entity = (await entityResponse.json()).data;
  for (const [userId, roleIds] of [[reviewer, ["finance_manager", "policy_reviewer"]], [finance, ["finance_manager"]]]) expect((await page.request.post(`/api/v1/orgs/${org}/memberships`, { headers: { "Idempotency-Key": randomUUID() }, data: { userId, roleIds, allowedEntityIds: [entity.id], siteIds: [], active: true } })).status()).toBe(201);
  await page.reload(); await page.getByRole("link", { name: "Approval policies and audit", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Approval policies and audit", exact: true })).toBeVisible({ timeout: 30000 });
  const form = page.getByRole("form", { name: "Create approval policy" });
  await form.getByLabel("Policy name", { exact: true }).fill("Independent journal review"); await form.getByLabel("Effective from", { exact: true }).fill("2026-01-01"); await form.getByLabel("Effective to (exclusive)", { exact: true }).fill("2027-01-01");
  await form.getByLabel("Range 1 minimum", { exact: true }).fill("1.00"); await form.getByRole("button", { name: "Save policy draft", exact: true }).click(); await expect(form.getByRole("alert")).toContainText("cover every amount from zero");
  await form.getByLabel("Range 1 minimum", { exact: true }).fill("0.00"); await form.getByLabel("Range 1 upper bound", { exact: true }).fill("1000.00"); await form.getByRole("button", { name: "Add threshold range", exact: true }).click();
  await form.getByLabel("Range 2 checkers", { exact: true }).fill("2");
  const base = `/api/v1/orgs/${org}/entities/${entity.id}/approval-policies`;
  const created = page.waitForResponse(response => response.url().endsWith(base) && response.request().method() === "POST"); await form.getByRole("button", { name: "Save policy draft", exact: true }).click();
  const response = await created; expect(response.status()).toBe(201); expect(response.headers().etag).toBe('"1"'); const draft = (await response.json()).data;
  expect(draft.thresholds[1].minInclusive).toBe("1000.00"); expect(draft.thresholds[1].numberOfDistinctApprovers).toBe(2); expect(response.headers().location).toBe(`${base}/${draft.id}`);
  const makerCard = page.getByLabel("Policy Independent journal review", { exact: true }); await expect(makerCard).toBeVisible(); await expect(makerCard.getByRole("button", { name: "Activate policy", exact: true })).toBeDisabled();
  const ordinary = await playwright.request.newContext({ baseURL: "http://localhost:3000", extraHTTPHeaders: clientHeaders() }), reviewerContext = await browser.newContext({ extraHTTPHeaders: clientHeaders() });
  try {
    expect((await ordinary.post("/api/auth/sign-in/email", { data: { email: financeEmail, password } })).status()).toBe(200);
    expect((await ordinary.post(`${base}/${draft.id}/activate`, { headers: { "Idempotency-Key": randomUUID(), "If-Match": '"1"' }, data: {} })).status()).toBe(403);
    const reviewPage = await reviewerContext.newPage(); reviewPage.on("pageerror", error => errors.push(error.message));
    await reviewPage.goto("http://localhost:3000/sign-in"); await reviewPage.getByLabel("Email", { exact: true }).fill(reviewerEmail); await reviewPage.getByLabel("Password", { exact: true }).fill(password); await reviewPage.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(reviewPage).toHaveURL(/\/workspace$/, { timeout: 30000 });
    await reviewPage.getByRole("link", { name: "Approval policies and audit", exact: true }).click();
    const reviewCard = reviewPage.getByLabel("Policy Independent journal review", { exact: true }); await expect(reviewCard).toBeVisible({ timeout: 30000 });
    expect((await reviewPage.request.post(`${base}/${draft.id}/activate`, { headers: { "Idempotency-Key": randomUUID() }, data: {} })).status()).toBe(428);
    expect((await reviewPage.request.post(`${base}/${draft.id}/activate`, { headers: { "Idempotency-Key": randomUUID(), "If-Match": '"1"' }, data: { status: "active" } })).status()).toBe(422);
    await reviewCard.getByLabel("Review reason (optional)").fill("Reviewed thresholds and dates independently"); await reviewCard.getByRole("button", { name: "Activate policy", exact: true }).click(); await reviewPage.getByRole("button", { name: "Cancel review", exact: true }).click();
    expect((await reviewPage.request.get(`${base}/${draft.id}`)).status()).toBe(200); expect((await (await reviewPage.request.get(`${base}/${draft.id}`)).json()).data.status).toBe("draft");
    await reviewCard.getByRole("button", { name: "Activate policy", exact: true }).click();
    const activated = reviewPage.waitForResponse(r => r.url().endsWith(`${base}/${draft.id}/activate`) && r.request().method() === "POST"); await reviewPage.getByRole("button", { name: "Confirm activation", exact: true }).click(); expect((await activated).status()).toBe(200);
    await expect(reviewCard.getByText("active", { exact: true })).toBeVisible({ timeout: 15000 }); await reviewPage.reload(); await expect(reviewCard.getByText(/version 2/)).toBeVisible();
    const newInput = { name: "Future independent review", effectiveFrom: "2027-01-01", effectiveTo: "2028-01-01", aggregateTypes: ["journal"], currency: "NPR", makerChecker: true, thresholds: [{ minInclusive: "0.00", requiredPermission: "journals.approve", numberOfDistinctApprovers: 1 }] };
    const next = (await (await page.request.post(base, { headers: { "Idempotency-Key": randomUUID() }, data: newInput })).json()).data;
    await reviewPage.reload(); const staleCard = reviewPage.getByLabel("Policy Future independent review", { exact: true });
    const key = randomUUID(), activation = { headers: { "Idempotency-Key": key, "If-Match": '"1"' }, data: {} };
    const firstActivation = await reviewPage.request.post(`${base}/${next.id}/activate`, activation); expect(firstActivation.status()).toBe(200);
    const replay = await reviewPage.request.post(`${base}/${next.id}/activate`, activation); expect(replay.status()).toBe(200); expect((await replay.json()).data).toEqual((await firstActivation.json()).data);
    await staleCard.getByRole("button", { name: "Activate policy", exact: true }).click(); const stale = reviewPage.waitForResponse(r => r.status() === 412 && r.url().endsWith(`${base}/${next.id}/activate`)); await reviewPage.getByRole("button", { name: "Confirm activation", exact: true }).click(); await stale; await expect(staleCard.getByRole("alert")).toContainText("Reload");
    await staleCard.getByRole("button", { name: "Reload current policy", exact: true }).click(); await expect(staleCard.getByText("active", { exact: true })).toBeVisible();
    const auditBase = `/api/v1/orgs/${org}/entities/${entity.id}/audit-events`;
    const history = (await (await reviewPage.request.get(`${auditBase}?action=approval_policy.activate&limit=100`)).json()).data; expect(history).toHaveLength(2); expect(history.every((event: { actorId: string; action: string }) => event.actorId === reviewer && event.action === "approval_policy.activate")).toBe(true);
    expect((await (await reviewPage.request.get(`${auditBase}?action=membership.create`)).json()).data).toEqual([]);
    const first = (await (await reviewPage.request.get(`${auditBase}?limit=1`)).json()); expect(first.meta.nextCursor).not.toBeNull(); expect((await (await reviewPage.request.get(`${auditBase}?limit=1&cursor=${first.meta.nextCursor}`)).json()).data[0].id).not.toBe(first.data[0].id);
    await reviewPage.getByLabel("Action", { exact: true }).fill("approval_policy.activate"); await reviewPage.getByRole("button", { name: "Filter history", exact: true }).click(); await expect(reviewPage.getByRole("region", { name: "Entity audit history" }).getByText("approval_policy.activate", { exact: true })).toHaveCount(2);
    await reviewPage.screenshot({ path: ".local/screenshots/approval-controls-desktop.png", fullPage: true }); await reviewPage.setViewportSize({ width: 360, height: 800 });
    expect(await reviewPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await reviewPage.screenshot({ path: ".local/screenshots/approval-controls-mobile.png", fullPage: true });
    await reviewPage.getByRole("link", { name: "Clear filters", exact: true }).click(); await reviewPage.getByRole("button", { name: "Filter history", exact: true }).click(); await expect(reviewPage.getByRole("heading", { name: "Approval policies and audit", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL }); try { expect((await admin.query("SELECT * FROM audit_events WHERE organization_id=$1 AND action='approval_policy.activate'", [org])).rowCount).toBe(2); } finally { await admin.end(); }
  } finally { await ordinary.dispose(); await reviewerContext.close(); }
});
