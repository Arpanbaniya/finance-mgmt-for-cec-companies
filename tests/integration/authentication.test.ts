import { config } from "dotenv";
import { randomUUID, randomBytes } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, expect, it } from "vitest";
config({ path: ".env.local", quiet: true });
process.env.INITIAL_SETUP = "true";
const email = `test-${randomUUID()}@example.invalid`, password = randomBytes(24).toString("base64url");
let userId = "";
const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
beforeAll(async () => {
  if (new URL(process.env.MIGRATION_DATABASE_URL ?? "").hostname !== "127.0.0.1") throw new Error("Local auth tests only.");
  const { auth } = await import("@/features/identity/auth");
  const identity = await auth().api.signUpEmail({ body: { email, password, name: "Auth test" } }); userId = identity.user.id;
});
afterAll(async () => { if (userId) await admin.query("DELETE FROM auth_user WHERE id=$1", [userId]); await admin.end(); const { databasePool } = await import("@/db/client"); await databasePool().end(); });
it("public signup stays unavailable even when operator setup is enabled", async () => {
  const { POST } = await import("@/app/api/auth/[...all]/route");
  const response = await POST(new Request("http://localhost:3000/api/auth/sign-up/email", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" }, body: JSON.stringify({ email: "uninvited@example.invalid", password, name: "Uninvited" }) }));
  expect(response.status).toBe(404);
});
it("passwords are hashed by the auth library", async () => {
  const row = await admin.query("SELECT password FROM auth_account WHERE user_id=$1 AND provider_id='credential'", [userId]);
  expect(row.rows[0].password).not.toBe(password); expect(row.rows[0].password.length).toBeGreaterThan(60);
});
it("sign-in creates an HttpOnly SameSite cookie and session revocation is immediate", async () => {
  const { POST, GET } = await import("@/app/api/auth/[...all]/route");
  const response = await POST(new Request("http://localhost:3000/api/auth/sign-in/email", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" }, body: JSON.stringify({ email, password }) }));
  expect(response.status).toBe(200);
  const header = response.headers.get("set-cookie")!; expect(header).toMatch(/HttpOnly/i); expect(header).toMatch(/SameSite=Lax/i);
  const cookie = header.split(";")[0];
  const session = await GET(new Request("http://localhost:3000/api/auth/get-session", { headers: { cookie } }));
  expect((await session.json()).user.id).toBe(userId);
  await admin.query("DELETE FROM auth_session WHERE user_id=$1", [userId]);
  const revoked = await GET(new Request("http://localhost:3000/api/auth/get-session", { headers: { cookie } }));
  expect(await revoked.json()).toBeNull();
});
it("cross-origin sign-in is blocked by the auth provider", async () => {
  const { POST } = await import("@/app/api/auth/[...all]/route");
  const response = await POST(new Request("http://localhost:3000/api/auth/sign-in/email", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://attacker.example" }, body: JSON.stringify({ email, password }) }));
  expect(response.status).toBe(403);
});
