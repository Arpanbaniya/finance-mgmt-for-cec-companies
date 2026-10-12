import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { calculateStatements, type AccountMovementValue } from "@/domain/statements";
const row = (type: "revenue" | "expense", category: AccountMovementValue["profitLossCategory"], amount: string, behavior: AccountMovementValue["costBehavior"] = "unclassified"): AccountMovementValue => ({
  accountId: randomUUID(), accountVersion: 1, code: category ?? "LEGACY", name: category ?? "Legacy", type, normalSide: type === "revenue" ? "credit" : "debit", statementSection: type === "revenue" ? "revenue" : "expenses",
  profitLossCategory: category, costBehavior: behavior, openingDebit: "0.00", openingCredit: "0.00", periodDebit: type === "expense" ? amount : "0.00", periodCredit: type === "revenue" ? amount : "0.00", yearDebit: type === "expense" ? amount : "0.00", yearCredit: type === "revenue" ? amount : "0.00" });
function report(rows: AccountMovementValue[]) {
  // Independently balance the synthetic fixture without deriving expected P&L.
  const bank: AccountMovementValue = { ...row("revenue", "revenue", "0.00"), code: "BANK", name: "Bank", type: "asset", normalSide: "debit", statementSection: "assets", profitLossCategory: "not_applicable" };
  return calculateStatements([...rows, ...rows.map((item, index) => ({ ...bank, accountId: randomUUID(), code: `BANK-${index}`, periodDebit: item.periodCredit, periodCredit: item.periodDebit, yearDebit: item.yearCredit, yearCredit: item.yearDebit }))]);
}
const fixture = () => [row("revenue", "revenue", "1000.00"), row("expense", "direct_cost", "300.00", "variable"), row("expense", "direct_cost", "100.00", "fixed"),
  row("expense", "operating_expense", "200.00", "fixed"), row("expense", "operating_expense", "50.00", "variable"), row("revenue", "other_income", "20.00"), row("expense", "finance_cost", "30.00"), row("expense", "income_tax", "40.00")];
it("separates exact gross, contribution, operating, pre-tax and net profit with independent numbers", () => {
  const value = report(fixture());
  expect(value.profitLoss).toMatchObject({ mappingComplete: true, operatingRevenue: "1000.00", directCosts: "400.00", operatingExpenses: "250.00", otherIncome: "20.00", financeCosts: "30.00", incomeTaxExpense: "40.00",
    grossProfit: "600.00", contributionMargin: "650.00", operatingProfit: "350.00", profitBeforeTax: "340.00", netProfit: "300.00", unclassifiedRevenue: "0.00", unclassifiedExpenses: "0.00", unclassifiedAccounts: [], missingCostBehavior: [] });
  expect(value.incomeMovement.result).toBe("300.00"); expect(value.balanceSheet.currentYearResult).toBe("300.00");
});
it("does not invent subtotals for legacy or explicitly unclassified movement", () => {
  const legacy = row("expense", undefined, "0.01"), value = report([...fixture(), legacy]);
  expect(value.profitLoss).toMatchObject({ mappingComplete: false, unclassifiedExpenses: "0.01", grossProfit: null, operatingProfit: null, profitBeforeTax: null, netProfit: null, contributionMargin: null });
  expect(value.profitLoss.unclassifiedAccounts[0]).toMatchObject({ accountId: legacy.accountId, accountVersion: 1 }); expect(value.incomeMovement.result).toBe("299.99");
});
it("does not let a zero-net unclassified debit/credit pair hide incomplete mapping", () => {
  const unknown = { ...row("expense", "unclassified", "1.00"), periodCredit: "1.00", yearCredit: "1.00" };
  expect(report([unknown]).profitLoss).toMatchObject({ mappingComplete: false, unclassifiedExpenses: "0.00", netProfit: null });
});
it("only makes contribution unavailable when a classified cost has unknown behavior", () => {
  expect(report([row("revenue", "revenue", "10.00"), row("expense", "direct_cost", "2.00")]).profitLoss).toMatchObject({ mappingComplete: true, grossProfit: "8.00", operatingProfit: "8.00", netProfit: "8.00", contributionMargin: null });
});
it("retains each consumed version's category instead of retroactively using the latest category", () => {
  const old = row("expense", "direct_cost", "2.00", "variable"), next = { ...old, accountVersion: 2, profitLossCategory: "operating_expense" as const, costBehavior: "fixed" as const, periodDebit: "3.00", yearDebit: "3.00" };
  expect(report([row("revenue", "revenue", "10.00"), old, next]).profitLoss).toMatchObject({ directCosts: "2.00", operatingExpenses: "3.00", grossProfit: "8.00", contributionMargin: "8.00", operatingProfit: "5.00", netProfit: "5.00" });
});
it("preserves contra revenue, refunded expenses, tax credits and losses with signed amounts", () => {
  const reversed = fixture().map(item => ({ ...item, periodDebit: item.periodCredit, periodCredit: item.periodDebit, yearDebit: item.yearCredit, yearCredit: item.yearDebit }));
  expect(report(reversed).profitLoss).toMatchObject({ grossProfit: "-600.00", contributionMargin: "-650.00", operatingProfit: "-350.00", profitBeforeTax: "-340.00", incomeTaxExpense: "-40.00", netProfit: "-300.00" });
});
it("preserves paise beyond JavaScript safe integer bounds", () => {
  expect(report([row("revenue", "revenue", "9007199254740992.01"), row("expense", "direct_cost", "0.01", "variable")]).profitLoss.netProfit).toBe("9007199254740992.00");
});
it("rejects incompatible retained categories and behavior", () => {
  expect(() => report([row("expense", "revenue", "1.00")])).toThrow("P&L category");
  expect(() => report([row("expense", "income_tax", "1.00", "variable")])).toThrow("P&L category");
});
it("ignores unused mappings outside the period and represents a genuinely empty period", () => {
  const unused = { ...row("expense", undefined, "0.00"), openingDebit: "0.00" };
  expect(report([unused]).profitLoss).toMatchObject({ mappingComplete: true, grossProfit: "0.00", netProfit: "0.00", contributionMargin: "0.00", unclassifiedAccounts: [] });
});
