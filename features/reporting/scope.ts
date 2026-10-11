import type { PoolClient } from "pg";
import { DomainError } from "@/domain/errors";
import { withScope } from "@/features/identity/scope";

/** Shared internal finance-ledger read boundary; not an owner report grant. */
export function withLedgerReportScope<T>(userId: string, organizationId: string, entityId: string, work: (client: PoolClient) => Promise<T>) {
  return withScope(userId, organizationId, entityId, "reports.read", async client => {
    const allowed = await client.query("SELECT app_security.can_read_accounts($1) AS allowed", [organizationId]);
    if (!allowed.rows[0].allowed) throw new DomainError("FORBIDDEN", "Finance ledger read authority is required for this internal report.", 403);
    await client.query("SET LOCAL lock_timeout='2s'");
    await client.query("SET LOCAL statement_timeout='5s'");
    // Posters take this lock before recording the journal timestamp. Capture
    // new report knowledge only after earlier in-flight postings have finished.
    await client.query("SELECT app_security.lock_policy_scope($1,$2)", [organizationId, entityId]);
    return work(client);
  });
}
