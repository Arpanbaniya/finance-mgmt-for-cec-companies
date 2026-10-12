import { z } from "zod";
import { CalendarDate } from "@/domain/finance-setup";
import { AccountType } from "@/domain/accounts";
import { ReportInstant, StatementAmount } from "@/domain/statements";
import { GeneralLedgerResult, OwnerStatementMetadata, OwnerStatementResult, StatementMetadata } from "./contracts";

export const ReportType = z.enum(["trial-balance", "general-ledger", "profit-loss", "balance-sheet", "cash-flow", "ar-ageing", "ap-ageing", "party-statement", "bank-reconciliation", "payroll-summary", "worker-advances", "statutory-liabilities", "labour-profitability", "cost-center-profit-loss", "utilization"]);
export const availableReports = ["profit-loss", "balance-sheet", "trial-balance", "general-ledger"] as const;
export const ReportQuery = z.strictObject({ reportType: ReportType, fromDate: CalendarDate.optional(), toDateExclusive: CalendarDate.optional(), asOfDate: CalendarDate.optional(),
  knownAt: ReportInstant.optional(), accountId: z.uuid().toLowerCase().optional(), limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(), includeComparative: z.boolean().default(false),
}).superRefine((query, context) => {
  if (!(availableReports as readonly string[]).includes(query.reportType)) return;
  const issue = (field: string, message: string) => context.addIssue({ code: "custom", path: [field], message });
  if (query.reportType === "balance-sheet") {
    if (!query.asOfDate || query.asOfDate === "9999-12-31") issue("asOfDate", "Choose an as-of date through 9999-12-30.");
    if (query.fromDate || query.toDateExclusive) issue("fromDate", "Balance sheet uses asOfDate, not interval filters.");
  } else {
    if (!query.fromDate || !query.toDateExclusive || query.fromDate >= query.toDateExclusive) issue("fromDate", "Choose a valid start and a later exclusive end date.");
    if (query.asOfDate) issue("asOfDate", "This report uses an explicit interval.");
  }
  if (query.reportType === "general-ledger" && !query.accountId) issue("accountId", "Choose an account for the general ledger.");
  if (query.reportType !== "general-ledger" && query.accountId) issue("accountId", "Account filtering applies only to the general ledger.");
  if (!["general-ledger", "trial-balance"].includes(query.reportType) && (query.limit !== undefined || query.cursor)) issue("cursor", "Pagination applies only to trial balance and general ledger.");
});
export type ReportQueryValue = z.infer<typeof ReportQuery>;
const sides = z.strictObject({ debit: StatementAmount, credit: StatementAmount });
const TrialRow = z.strictObject({ accountId: z.uuid(), code: z.string().min(1).max(100), name: z.string().min(1).max(200), type: AccountType,
  normalSide: z.enum(["debit", "credit"]), accountVersions: z.array(z.number().int().positive()).max(10000), opening: sides, movement: sides, closing: sides });
export const TrialBalanceResult = z.strictObject({ reportType: z.literal("trial-balance"), view: z.literal("finance"), metadata: StatementMetadata,
  rows: z.array(TrialRow).max(100), totals: z.strictObject({ opening: sides, movement: sides, closing: sides }),
  page: z.strictObject({ totalRows: z.number().int().min(0).max(10000), nextCursor: z.string().max(2048).nullable() }), limitations: z.array(z.string()).max(10) });
const SummaryMetadata = OwnerStatementMetadata.omit({ reportVersion: true }).extend({ reportVersion: z.enum(["owner-statement-summary-v1", "statement-foundation-v2"]) });
export const ProfitLossReport = z.strictObject({ reportType: z.literal("profit-loss"), view: z.enum(["finance", "owner"]), metadata: SummaryMetadata,
  totals: OwnerStatementResult.shape.profitLoss, incomeMovement: OwnerStatementResult.shape.incomeMovement, limitations: z.array(z.string()).max(10) });
export const BalanceSheetReport = z.strictObject({ reportType: z.literal("balance-sheet"), view: z.enum(["finance", "owner"]), metadata: SummaryMetadata,
  totals: OwnerStatementResult.shape.balanceSheet, limitations: z.array(z.string()).max(10) });
export const LedgerReport = GeneralLedgerResult.extend({ reportType: z.literal("general-ledger"), view: z.literal("finance") });
export const ReportResult = z.discriminatedUnion("reportType", [TrialBalanceResult, LedgerReport, ProfitLossReport, BalanceSheetReport]);
export type ReportResultValue = z.infer<typeof ReportResult>;
