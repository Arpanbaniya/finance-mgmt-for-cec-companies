import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
config({ path: ".env.local", quiet: true });
const email = process.env.BOOTSTRAP_EMAIL, password = process.env.BOOTSTRAP_PASSWORD;
if (!email || !password || password.length < 14) throw new Error("Set BOOTSTRAP_EMAIL and a BOOTSTRAP_PASSWORD of at least 14 characters in your environment.");
if (process.env.VERCEL || process.env.NODE_ENV === "production") throw new Error("Run bootstrap from an operator workstation, never a web deployment.");
const migration = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const client = await migration.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(745172020)");
  if ((await client.query("SELECT id FROM organizations LIMIT 1")).rowCount) throw new Error("Initial setup already completed. Existing data will not be replaced.");
  process.env.INITIAL_SETUP = "true";
  const { auth } = await import("../features/identity/auth");
  const identity = await auth().api.signUpEmail({ body: { email, password, name: "Organization administrator" } });
  const organizationId = randomUUID();
  // Operator supplies and verifies the initial identity; no public verification bypass.
  await client.query("UPDATE auth_user SET email_verified=true WHERE id=$1", [identity.user.id]);
  await client.query("INSERT INTO organizations(id,name) VALUES($1,$2)", [organizationId, process.env.BOOTSTRAP_ORGANIZATION ?? "KaamLedger demo organization"]);
  await client.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids,active) VALUES($1,$2,$3,'[\"organization_admin\"]','[]','[]',true)", [randomUUID(), organizationId, identity.user.id]);
  await client.query("COMMIT");
  console.log(`Initial organization created: ${organizationId}. Sign in using your operator-supplied credentials.`);
} catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); await migration.end(); const { databasePool } = await import("../db/client"); await databasePool().end(); }
