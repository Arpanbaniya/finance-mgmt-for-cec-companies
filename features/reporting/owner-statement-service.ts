import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { StatementInterval } from "@/domain/statements";
import { calculateOwnerStatements } from "@/domain/owner-statements";
import { withScope } from "@/features/identity/scope";
import { OwnerStatementResult } from "./contracts";

/** Internal owner-only entity summary. No catalog route or UI is exposed yet. */
export async function readOwnerStatementSummary(userId: string, organizationId: string, entityId: string, value: unknown) {
  z.uuid().parse(organizationId); z.uuid().parse(entityId);
  const query = StatementInterval.parse(value);
  return withScope(userId, organizationId, entityId, "dashboard.owner", async client => {
    await client.query("SET LOCAL lock_timeout='2s'");
    await client.query("SET LOCAL statement_timeout='5s'");
    let payload;
    try {
      const result = await client.query("SELECT app_security.owner_statement_aggregates($1,$2,$3,$4,$5) AS summary", [organizationId, entityId, query.fromDate, query.toDateExclusive, query.knownAt ?? null]);
      payload = result.rows[0].summary;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "42501") throw new DomainError("FORBIDDEN", "Owner summary authority is required.", 403);
      if (code === "22023") throw new DomainError("INVALID_REPORT_CUTOFF", "The knowledge cutoff cannot be in the future.");
      if (code === "54000") throw new DomainError("REPORT_TOO_LARGE", "This report exceeds the retained-account aggregate limit; no partial totals are returned.");
      if (code === "22000") throw new DomainError("INVALID_REPORT_MAPPING", "A retained account version is missing.");
      throw error;
    }
    if (!payload) throw new DomainError("FISCAL_YEAR_REQUIRED", "Configure the fiscal year containing the report's as-of date.");
    const calculated = calculateOwnerStatements(payload.buckets.map((bucket: Record<string, unknown>) => ({ ...bucket,
      ...Object.fromEntries(["openingDebit", "openingCredit", "periodDebit", "periodCredit", "yearDebit", "yearCredit"].map(key => [key, bucket[key] === "0" ? "0.00" : bucket[key]])),
    })));
    return OwnerStatementResult.parse({ metadata: payload.metadata, ...calculated, limitations: [
      "Entity-only aggregate totals; raw accounts, journals, source details and private payroll or candidate data are not included.",
      "Missing consumed P&L categories or fixed/variable cost behavior make the affected subtotals unavailable; ask finance to review mappings.",
      "Income-tax expense is recorded ledger movement, not a computed tax liability or statutory return.",
      "Prior unclosed results are separate; this temporal read is not an approved durable close snapshot or year-close workflow.",
      "Comparatives, dimensions, available cash, AR/AP ageing, payroll funding, forecast, public report contracts and screens remain pending.",
    ] });
  });
}
