import { expect, it } from "vitest";
import { calculateOwnerStatements, StatementBucket } from "@/domain/owner-statements";
import { statementSections } from "@/domain/accounts";
import type { z } from "zod";

type Bucket = z.infer<typeof StatementBucket>;
function bucket(type: Bucket["type"], debit: string, credit: string, category: Bucket["profitLossCategory"] = "unclassified", behavior: Bucket["costBehavior"] = "unclassified"): Bucket {
  return { type, normalSide: type === "asset" || type === "expense" ? "debit" : "credit", statementSection: statementSections[type], profitLossCategory: category, costBehavior: behavior,
    openingDebit: "0.00", openingCredit: "0.00", periodDebit: debit, periodCredit: credit, yearDebit: debit, yearCredit: credit };
}
const fixture = () => [bucket("asset", "114800.00", "0.00"), bucket("liability", "0.00", "4500.00"), bucket("equity", "0.00", "100000.00"),
  bucket("revenue", "0.00", "33000.00", "revenue"), bucket("expense", "22000.00", "0.00", "direct_cost", "variable"), bucket("expense", "700.00", "0.00", "operating_expense", "fixed")];
it("reuses statement arithmetic for independent owner totals without returning synthetic witnesses", () => {
  const result = calculateOwnerStatements(fixture());
  expect(result.incomeMovement).toEqual({ revenue: "33000.00", expenses: "22700.00", result: "10300.00" });
  expect(result.balanceSheet).toEqual({ assets: "114800.00", liabilities: "4500.00", postedEquity: "100000.00", currentYearResult: "10300.00", priorUnclosedResult: "0.00", equity: "110300.00", difference: "0.00" });
  expect(result.profitLoss).toMatchObject({ mappingComplete: true, contributionMappingComplete: true, grossProfit: "11000.00", contributionMargin: "11000.00", operatingProfit: "10300.00", profitBeforeTax: "10300.00", netProfit: "10300.00" });
  expect(Object.keys(result).sort()).toEqual(["balanceSheet", "incomeMovement", "profitLoss"]);
  for (const word of ["accountId", "code", "name", "trialBalance", "BUCKET", "unclassifiedAccounts", "missingCostBehavior"]) expect(JSON.stringify(result)).not.toContain(word);
});
it("does not label unknown mappings as zero or expose identity witnesses", () => {
  const rows = fixture(); rows[3].profitLossCategory = "unclassified";
  const result = calculateOwnerStatements(rows);
  expect(result.profitLoss).toMatchObject({ mappingComplete: false, contributionMappingComplete: false, unclassifiedRevenue: "33000.00", netProfit: null, grossProfit: null, contributionMargin: null });
  expect(result.incomeMovement.result).toBe("10300.00");
  rows[3].profitLossCategory = "revenue"; rows[4].costBehavior = "unclassified";
  expect(calculateOwnerStatements(rows).profitLoss).toMatchObject({ mappingComplete: true, contributionMappingComplete: false, contributionMargin: null, netProfit: "10300.00" });
});
it("preserves zero-net activity as an unknown-mapping blocker", () => {
  const rows = fixture(); rows.push(bucket("expense", "0.01", "0.01"));
  expect(calculateOwnerStatements(rows).profitLoss).toMatchObject({ mappingComplete: false, unclassifiedExpenses: "0.00", netProfit: null });
});
it("excludes opening-only unknown mappings from period classification blockers", () => {
  const opening = [...fixture().slice(0, 4), bucket("expense", "22700.00", "0.00")];
  const rows = opening.map(row => ({ ...row, profitLossCategory: "unclassified" as const, costBehavior: "unclassified" as const,
    openingDebit: row.periodDebit, openingCredit: row.periodCredit, periodDebit: "0.00", periodCredit: "0.00" }));
  expect(calculateOwnerStatements(rows).profitLoss).toMatchObject({ mappingComplete: true, contributionMappingComplete: true, netProfit: "0.00" });
  expect(calculateOwnerStatements(rows).balanceSheet.assets).toBe("114800.00");
});
it("fails closed for duplicate buckets, invalid mapping, raw fields and one-paisa imbalance", () => {
  const rows = fixture();
  expect(() => calculateOwnerStatements([...rows, rows[0]])).toThrow("distinct");
  expect(() => calculateOwnerStatements([{ ...rows[0], periodDebit: "114800.01" }, ...rows.slice(1)])).toThrow("balance exactly");
  expect(() => calculateOwnerStatements([{ ...rows[0], statementSection: "revenue" }, ...rows.slice(1)])).toThrow();
  for (const field of ["accountId", "name", "sourceId", "workerId"]) expect(() => calculateOwnerStatements([{ ...rows[0], [field]: "private" }, ...rows.slice(1)])).toThrow();
});
it("retains paise above safe integer range and fails rather than truncating overflow", () => {
  const amount = "9007199254740992.01";
  expect(calculateOwnerStatements([bucket("asset", amount, "0.00"), bucket("equity", "0.00", amount)]).balanceSheet.assets).toBe(amount);
  const maximum = "999999999999999999.99";
  expect(() => calculateOwnerStatements([bucket("asset", maximum, "0.00"), { ...bucket("asset", maximum, "0.00"), normalSide: "credit" }, bucket("equity", "0.00", maximum), { ...bucket("equity", "0.00", maximum), normalSide: "debit" }])).toThrow("supported range");
  expect(() => calculateOwnerStatements(Array.from({ length: 321 }, () => bucket("asset", "0.00", "0.00")))).toThrow();
});
it("presents genuine empty and contra balances exactly", () => {
  expect(calculateOwnerStatements([]).balanceSheet.assets).toBe("0.00");
  expect(calculateOwnerStatements([]).profitLoss.netProfit).toBe("0.00");
  const result = calculateOwnerStatements([bucket("asset", "0.00", "0.01"), bucket("expense", "0.01", "0.00", "operating_expense", "fixed")]);
  expect(result.balanceSheet).toMatchObject({ assets: "-0.01", currentYearResult: "-0.01", equity: "-0.01", difference: "0.00" });
  expect(result.profitLoss.netProfit).toBe("-0.01");
});
