import { z } from "zod";
import { AccountMovement, calculateStatements } from "./statements";
import { DomainError } from "./errors";

// The privileged database boundary has already combined every consumed
// version into a fixed classification bucket. Real account identity must not
// cross it. Synthetic witnesses exist only to reuse the one statement engine;
// they are not accounts, drill-down references or a trial balance.
export const StatementBucket = z.strictObject({ type: AccountMovement.shape.type, normalSide: AccountMovement.shape.normalSide,
  statementSection: AccountMovement.shape.statementSection, profitLossCategory: AccountMovement.shape.profitLossCategory, costBehavior: AccountMovement.shape.costBehavior,
  openingDebit: AccountMovement.shape.openingDebit, openingCredit: AccountMovement.shape.openingCredit, periodDebit: AccountMovement.shape.periodDebit,
  periodCredit: AccountMovement.shape.periodCredit, yearDebit: AccountMovement.shape.yearDebit, yearCredit: AccountMovement.shape.yearCredit });
export function summarizeProfitLoss(profitLoss: ReturnType<typeof calculateStatements>["profitLoss"]) {
  const { unclassifiedAccounts, missingCostBehavior, ...totals } = profitLoss;
  return { ...totals, contributionMappingComplete: unclassifiedAccounts.length === 0 && missingCostBehavior.length === 0 };
}
export function calculateOwnerStatements(value: unknown) {
  const buckets = z.array(StatementBucket).max(320).parse(value);
  const keys = buckets.map(row => [row.type, row.normalSide, row.statementSection, row.profitLossCategory ?? "unclassified", row.costBehavior ?? "unclassified"].join(":"));
  if (new Set(keys).size !== keys.length) throw new DomainError("DUPLICATE_REPORT_BUCKET", "Statement classification buckets must be distinct.");
  const calculated = calculateStatements(buckets.map((row, index) => ({ ...row,
    accountId: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
    accountVersion: 1, code: `BUCKET-${index + 1}`, name: "Statement classification aggregate",
  })));
  return { incomeMovement: calculated.incomeMovement, balanceSheet: calculated.balanceSheet,
    profitLoss: summarizeProfitLoss(calculated.profitLoss) };
}
