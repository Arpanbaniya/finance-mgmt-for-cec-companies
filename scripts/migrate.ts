import { config } from "dotenv";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { runtimeRole } from "../db/runtime-config";
config({ path: ".env.local", quiet: true });
if (!process.env.MIGRATION_DATABASE_URL || !process.env.DATABASE_URL) throw new Error("Both migration and runtime database URLs are required.");
runtimeRole(process.env.DATABASE_URL, process.env.SUPABASE_PROJECT_REF);
const runtime = new URL(process.env.DATABASE_URL);
const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(745172019)");
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
  const files = [
    ...(await readdir("db/generated")).filter(f => f.endsWith(".sql")).sort().map(f => `db/generated/${f}`),
    ...(await readdir("db/migrations")).filter(f => f.endsWith(".sql")).sort().map(f => `db/migrations/${f}`)
  ];
  for (const file of files) {
    const sql = await readFile(file, "utf8"), hash = createHash("sha256").update(sql).digest("hex");
    const prior = await client.query("SELECT hash FROM schema_migrations WHERE name=$1", [file]);
    if (prior.rowCount) { if (prior.rows[0].hash !== hash) throw new Error(`Applied migration changed: ${file}`); continue; }
    await client.query(sql); await client.query("INSERT INTO schema_migrations(name,hash) VALUES($1,$2)", [file, hash]);
    console.log(`Applied ${file}`);
  }
  const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname='kaamledger_app'");
  if (!exists.rowCount) {
    const password = decodeURIComponent(runtime.password).replaceAll("'", "''");
    await client.query(`CREATE ROLE kaamledger_app LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
  }
  await client.query("ALTER ROLE kaamledger_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS");
  await client.query("GRANT USAGE ON SCHEMA public,app_security TO kaamledger_app");
  await client.query("GRANT EXECUTE ON FUNCTION app_security.is_member(uuid),app_security.is_admin(uuid),app_security.can_entity(uuid,uuid),app_security.grant_created_entity(uuid,uuid) TO kaamledger_app");
  await client.query("GRANT SELECT,INSERT,UPDATE,DELETE ON auth_user,auth_session,auth_account,auth_verification,auth_rate_limit TO kaamledger_app");
  await client.query("GRANT SELECT ON organizations TO kaamledger_app");
  await client.query("GRANT SELECT,INSERT,UPDATE ON memberships,legal_entities,branches TO kaamledger_app");
  await client.query("GRANT SELECT,INSERT,UPDATE ON approval_policies TO kaamledger_app");
  await client.query("GRANT EXECUTE ON FUNCTION app_security.can_manage_policy(uuid),app_security.can_activate_policy(uuid),app_security.lock_policy_scope(uuid,uuid) TO kaamledger_app");
  await client.query("GRANT SELECT,INSERT ON audit_events,idempotency_results TO kaamledger_app");
  await client.query("GRANT SELECT,INSERT ON job_retries TO kaamledger_app");
  await client.query("GRANT SELECT,INSERT,UPDATE ON accounts TO kaamledger_app");
  await client.query("GRANT SELECT ON account_versions TO kaamledger_app");
  await client.query("GRANT SELECT,INSERT,UPDATE ON parties TO kaamledger_app");
  await client.query("GRANT SELECT ON party_versions TO kaamledger_app");
  await client.query("GRANT SELECT ON journal_entries,journal_lines TO kaamledger_app");
  await client.query("GRANT EXECUTE ON FUNCTION app_security.owner_statement_aggregates(uuid,uuid,date,date,timestamptz) TO kaamledger_app");
  await client.query("REVOKE ALL ON subledger_counterparties,subledger_sources,subledger_open_items,subledger_settlements,subledger_allocations,subledger_events,journal_reversal_hold_releases FROM kaamledger_app");
  await client.query("GRANT SELECT ON subledger_counterparties,subledger_sources,subledger_open_items,subledger_settlements,subledger_allocations,subledger_events TO kaamledger_app");
  await client.query("REVOKE ALL ON FUNCTION app_security.write_subledger_source(uuid,uuid,uuid,jsonb,text) FROM kaamledger_app");
  await client.query("REVOKE ALL ON FUNCTION app_security.require_journal_dependencies_clear(uuid,uuid,uuid,date) FROM kaamledger_app");
  await client.query("REVOKE ALL ON FUNCTION app_security.allocation_rectangles_within_limits(uuid,uuid,uuid,uuid,numeric,numeric) FROM kaamledger_app");
  await client.query("GRANT SELECT ON manual_journal_drafts,manual_journal_revisions TO kaamledger_app");
  await client.query("REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON manual_journal_drafts,manual_journal_revisions FROM kaamledger_app");
  await client.query("REVOKE ALL ON manual_journal_results FROM kaamledger_app");
  await client.query("REVOKE ALL ON manual_journal_execution_permits FROM kaamledger_app");
  await client.query("REVOKE ALL ON manual_journal_reversal_requests,manual_journal_reversals,journal_reversal_holds FROM kaamledger_app");
  await client.query("GRANT SELECT ON manual_journal_reversal_requests,manual_journal_reversals TO kaamledger_app");
  await client.query("GRANT EXECUTE ON FUNCTION app_security.request_manual_journal_reversal(uuid,uuid,uuid,integer,date,text,text,text) TO kaamledger_app");
  await client.query("GRANT EXECUTE ON FUNCTION app_security.transition_manual_journal(uuid,uuid,uuid,integer,text,text,text,text,text),app_security.manual_journal_review(uuid,uuid,uuid) TO kaamledger_app");
  await client.query("GRANT EXECUTE ON FUNCTION app_security.save_manual_journal_draft(uuid,uuid,uuid,integer,jsonb,text,text),app_security.cancel_manual_journal_draft(uuid,uuid,uuid,integer,text,text,text) TO kaamledger_app");
  await client.query("REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON journal_entries,journal_lines FROM kaamledger_app");
  // Never grant the raw writer; only the persisted approved-source adapter writes.
  await client.query("REVOKE ALL ON FUNCTION app_security.write_manual_journal(uuid,uuid,uuid,jsonb,text) FROM kaamledger_app");
  await client.query("GRANT SELECT ON journal_posting_sources,journal_posting_decisions,journal_source_postings,journal_posting_events TO kaamledger_app");
  await client.query("REVOKE ALL ON journal_posting_results FROM kaamledger_app");
  await client.query("REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON journal_posting_sources,journal_posting_decisions,journal_source_postings,journal_posting_events FROM kaamledger_app");
  await client.query("REVOKE ALL ON FUNCTION app_security.prepare_journal_posting_source(uuid,uuid,uuid,integer,jsonb,text,text) FROM kaamledger_app");
  await client.query("GRANT EXECUTE ON FUNCTION app_security.approve_journal_posting_source(uuid,uuid,uuid,integer,text,text),app_security.post_authorized_journal(uuid,uuid,uuid,integer,text,text) TO kaamledger_app");
  await client.query("GRANT SELECT,INSERT ON fiscal_years,fiscal_periods,account_mapping_revisions,account_mapping_entries TO kaamledger_app");
  await client.query("GRANT SELECT ON account_purposes,document_series,document_numbers TO kaamledger_app");
  await client.query("GRANT EXECUTE ON FUNCTION app_security.finance_setup_scope(uuid,uuid) TO kaamledger_app");
  await client.query("REVOKE ALL ON FUNCTION app_security.allocate_document_number(uuid,uuid,text,uuid,text,date) FROM kaamledger_app");
  await client.query("GRANT EXECUTE ON FUNCTION app_security.can_read_accounts(uuid),app_security.can_manage_accounts(uuid) TO kaamledger_app");
  await client.query("GRANT SELECT,INSERT,UPDATE ON outbox_events TO kaamledger_app");
  await client.query("GRANT SELECT,UPDATE ON alerts TO kaamledger_app");
  await client.query("REVOKE INSERT ON alerts FROM kaamledger_app");
  await client.query("GRANT EXECUTE ON FUNCTION app_security.policy_alert_recipient_eligible(uuid,uuid,text) TO kaamledger_app");
  await client.query("GRANT EXECUTE ON FUNCTION app_security.emit_policy_alert(uuid,uuid) TO kaamledger_app");
  await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
  await client.query("COMMIT");
  console.log("Migrations committed; restricted runtime grants verified.");
} catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); await pool.end(); }
