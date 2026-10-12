import { expect, it } from "vitest";
import { OwnerStatementResult } from "@/features/reporting/contracts";
import { calculateOwnerStatements } from "@/domain/owner-statements";
const metadata = { organizationId: "00000000-0000-4000-8000-000000000001", entityId: "00000000-0000-4000-8000-000000000002", currency: "NPR",
  fromDate: "2026-01-01", toDateExclusive: "2027-01-01", asOfDate: "2026-12-31", knownAt: "2026-10-12T01:00:00.123456Z", generatedAt: "2026-10-12T01:00:01.123456Z", ledgerWatermark: null,
  fiscalYearId: "00000000-0000-4000-8000-000000000003", fiscalYearStart: "2026-01-01", fiscalYearEndExclusive: "2027-01-01", reportingProfile: "demo_accrual", policyStatus: "demo",
  reportVersion: "owner-statement-summary-v1", mappingBasis: "posted-account-versions" };
it("validates the minimal owner summary and rejects private metadata or rows", () => {
  const result = { metadata, ...calculateOwnerStatements([]), limitations: ["Temporal aggregate, not a close snapshot."] };
  expect(OwnerStatementResult.safeParse(result).success).toBe(true);
  for (const field of ["journalCount", "retainedEarningsAccountId", "accountId", "sourceId", "workerId"]) expect(OwnerStatementResult.safeParse({ ...result, metadata: { ...metadata, [field]: "private" } }).success).toBe(false);
  for (const field of ["rows", "trialBalance", "journal", "buckets"]) expect(OwnerStatementResult.safeParse({ ...result, [field]: [] }).success).toBe(false);
  for (const field of ["unclassifiedAccounts", "missingCostBehavior"]) expect(OwnerStatementResult.safeParse({ ...result, profitLoss: { ...result.profitLoss, [field]: [] } }).success).toBe(false);
});
it("rejects numeric money, nonzero imbalance, unsupported currency and malformed dates", () => {
  const result = { metadata, ...calculateOwnerStatements([]), limitations: [] };
  expect(OwnerStatementResult.safeParse({ ...result, balanceSheet: { ...result.balanceSheet, assets: 0 } }).success).toBe(false);
  expect(OwnerStatementResult.safeParse({ ...result, balanceSheet: { ...result.balanceSheet, difference: "0.01" } }).success).toBe(false);
  expect(OwnerStatementResult.safeParse({ ...result, metadata: { ...metadata, currency: "USD" } }).success).toBe(false);
  expect(OwnerStatementResult.safeParse({ ...result, metadata: { ...metadata, fromDate: "2026-02-30" } }).success).toBe(false);
});
