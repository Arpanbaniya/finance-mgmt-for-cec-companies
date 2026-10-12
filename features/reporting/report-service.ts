import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { businessDate } from "@/domain/dates";
import { summarizeProfitLoss } from "@/domain/owner-statements";
import { withScope } from "@/features/identity/scope";
import { readStatementFoundation } from "./statement-service";
import { readOwnerStatementSummary } from "./owner-statement-service";
import { readGeneralLedger } from "./general-ledger-service";
import { availableReports, ReportQuery, ReportResult } from "./report-contracts";
import { decodeTrialCursor, encodeTrialCursor } from "./trial-balance-cursor";

export async function reportAccess(userId: string, organizationId: string, entityId: string) {
  return withScope(userId, organizationId, entityId, "reports.read", async client => Boolean((await client.query("SELECT app_security.can_read_accounts($1) AS allowed", [organizationId])).rows[0].allowed));
}
/** One catalog adapter; finite supported variants, no arbitrary table dispatch. */
export async function readReport(userId: string, organizationId: string, entityId: string, value: unknown) {
  organizationId = z.uuid().parse(organizationId).toLowerCase(); entityId = z.uuid().parse(entityId).toLowerCase();
  const query = ReportQuery.parse(value), finance = await reportAccess(userId, organizationId, entityId);
  if (!(availableReports as readonly string[]).includes(query.reportType) || query.includeComparative) throw new DomainError("FEATURE_NOT_ENABLED", "This report capability is not available yet.");
  if (!finance && ["general-ledger", "trial-balance"].includes(query.reportType)) throw new DomainError("FORBIDDEN", "Raw ledger reports require finance read authority.", 403);
  const limitations = ["Posted entity ledger only; no dimensional or comparative reporting. Missing classifications are unavailable, not zero.",
    "Recorded tax expense is not a statutory computation; this temporal report is not an approved close snapshot.",
    "Cash flow, ageing, forecast, payroll summaries, exports and year-close semantics remain under development."];
  if (query.reportType === "general-ledger") {
    const ledger = await readGeneralLedger(userId, organizationId, entityId, { accountId: query.accountId, fromDate: query.fromDate, toDateExclusive: query.toDateExclusive, knownAt: query.knownAt, limit: query.limit ?? 25, cursor: query.cursor });
    return ReportResult.parse({ ...ledger, limitations: ledger.limitations.filter(item => !item.startsWith("Public report")), reportType: "general-ledger", view: "finance" });
  }
  const cursor = query.cursor ? decodeTrialCursor(query.cursor, organizationId, entityId, query) : undefined;
  const interval = query.reportType === "balance-sheet" ? { fromDate: "1900-01-01", toDateExclusive: businessDate(new Date(new Date(`${query.asOfDate}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10)), knownAt: query.knownAt }
    : { fromDate: query.fromDate, toDateExclusive: query.toDateExclusive, knownAt: cursor?.knownAt ?? query.knownAt };
  const statement = finance ? await readStatementFoundation(userId, organizationId, entityId, interval) : await readOwnerStatementSummary(userId, organizationId, entityId, interval);
  if (query.reportType === "trial-balance") {
    if (!("trialBalance" in statement)) throw new DomainError("FORBIDDEN", "Finance read authority is required.", 403);
    const rows = statement.trialBalance.rows, start = cursor ? rows.findIndex(row => row.accountId === cursor.accountId) + 1 : 0;
    if (cursor && start === 0) throw new DomainError("INVALID_CURSOR", "Trial-balance anchor is unavailable at this cutoff.", 400);
    const page = rows.slice(start, start + (query.limit ?? 25)), last = page.at(-1);
    return ReportResult.parse({ reportType: "trial-balance", view: "finance", metadata: statement.metadata, rows: page, totals: statement.trialBalance.totals,
      page: { totalRows: rows.length, nextCursor: start + page.length < rows.length && last ? encodeTrialCursor({ kind: "trial-balance-v1", organizationId, entityId,
        fromDate: statement.metadata.fromDate, toDateExclusive: statement.metadata.toDateExclusive, knownAt: statement.metadata.knownAt, accountId: last.accountId }) : null }, limitations });
  }
  // Explicitly whitelist summary metadata; finance's retained-equity account
  // references and journal counts do not belong in the aggregate DTO either.
  const { metadata: source } = statement;
  const metadata = { organizationId: source.organizationId, entityId: source.entityId, currency: source.currency, fromDate: source.fromDate, toDateExclusive: source.toDateExclusive, asOfDate: source.asOfDate,
    knownAt: source.knownAt, generatedAt: source.generatedAt, ledgerWatermark: source.ledgerWatermark, fiscalYearId: source.fiscalYearId, fiscalYearStart: source.fiscalYearStart, fiscalYearEndExclusive: source.fiscalYearEndExclusive,
    reportingProfile: source.reportingProfile, policyStatus: source.policyStatus, reportVersion: source.reportVersion, mappingBasis: source.mappingBasis };
  if (query.reportType === "balance-sheet") return ReportResult.parse({ reportType: "balance-sheet", view: finance ? "finance" : "owner", metadata, totals: statement.balanceSheet, limitations });
  const totals = "trialBalance" in statement ? summarizeProfitLoss(statement.profitLoss) : statement.profitLoss;
  return ReportResult.parse({ reportType: "profit-loss", view: finance ? "finance" : "owner", metadata, totals, incomeMovement: statement.incomeMovement, limitations });
}
