import { z } from "zod";
import { AccountType, statementSections } from "./accounts";
import { CalendarDate } from "./finance-setup";
import { decimal, Exact, money } from "./money";
import { DomainError } from "./errors";

export const ReportInstant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/).refine(value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 23) === value.slice(0, 23)
    && CalendarDate.safeParse(value.slice(0, 10)).success;
}, "Use a valid UTC instant with six fractional digits.");
export const StatementInterval = z.strictObject({ fromDate: CalendarDate, toDateExclusive: CalendarDate, knownAt: ReportInstant.optional() })
  .refine(value => value.fromDate < value.toDateExclusive, "The exclusive end must follow the start date.");
export const StatementAmount = z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/).refine(value => {
  try { return !decimal(value).isNegative(); } catch { return false; }
}, "Use a nonnegative supported decimal string.");
export const SignedStatementAmount = z.string().regex(/^-?(?:0|[1-9]\d*)\.\d{2}$/).refine(value => {
  try { decimal(value); return value !== "-0.00"; } catch { return false; }
}, "Use a supported signed decimal string.");

/** Trusted, scoped SQL aggregates, not client-supplied accounting evidence. */
export const AccountMovement = z.strictObject({
  accountId: z.uuid(), accountVersion: z.number().int().positive(), code: z.string().min(1).max(100), name: z.string().min(1).max(200),
  type: AccountType, normalSide: z.enum(["debit", "credit"]),
  statementSection: z.enum(["assets", "liabilities", "equity", "revenue", "expenses"]),
  openingDebit: StatementAmount, openingCredit: StatementAmount, periodDebit: StatementAmount, periodCredit: StatementAmount,
  yearDebit: StatementAmount, yearCredit: StatementAmount,
}).refine(row => row.statementSection === statementSections[row.type], "Retained statement mapping must match the account type.");
export type AccountMovementValue = z.infer<typeof AccountMovement>;

function split(value: InstanceType<typeof Exact>) {
  return { debit: value.isPositive() ? money(value) : "0.00", credit: value.isNegative() ? money(value.negated()) : "0.00" };
}
function sum(values: string[]) { return values.reduce((total, value) => total.plus(decimal(value)), new Exact(0)); }

export function calculateStatements(value: unknown) {
  const rows = z.array(AccountMovement).max(10000).parse(value);
  const keys = rows.map(row => `${row.accountId}:${row.accountVersion}`);
  if (new Set(keys).size !== keys.length) throw new DomainError("DUPLICATE_ACCOUNT_VERSION", "Statement aggregates must have distinct retained account versions.");
  // A version is a presentation witness, not another account. Net balances
  // across its versions before splitting debit/credit in the trial balance.
  const grouped = new Map<string, { row: AccountMovementValue; versions: AccountMovementValue[] }>();
  for (const row of rows) {
    const existing = grouped.get(row.accountId);
    if (existing) {
      if (existing.row.type !== row.type || existing.row.code !== row.code || existing.row.normalSide !== row.normalSide) {
        throw new DomainError("INCONSISTENT_ACCOUNT_HISTORY", "Retained account classification is inconsistent.");
      }
      existing.versions.push(row);
      if (row.accountVersion > existing.row.accountVersion) existing.row = row;
    } else grouped.set(row.accountId, { row, versions: [row] });
  }
  const trialBalance = [...grouped.values()].map(({ row, versions }) => {
    const opening = sum(versions.map(v => v.openingDebit)).minus(sum(versions.map(v => v.openingCredit)));
    const debit = sum(versions.map(v => v.periodDebit)), credit = sum(versions.map(v => v.periodCredit));
    return { accountId: row.accountId, code: row.code, name: row.name, type: row.type, normalSide: row.normalSide,
      accountVersions: versions.map(v => v.accountVersion).sort((a, b) => a - b),
      opening: split(opening), movement: { debit: money(debit), credit: money(credit) }, closing: split(opening.plus(debit).minus(credit)) };
  }).sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : a.accountId < b.accountId ? -1 : 1);
  const trialTotals = {
    opening: { debit: money(sum(trialBalance.map(row => row.opening.debit))), credit: money(sum(trialBalance.map(row => row.opening.credit))) },
    movement: { debit: money(sum(trialBalance.map(row => row.movement.debit))), credit: money(sum(trialBalance.map(row => row.movement.credit))) },
    closing: { debit: money(sum(trialBalance.map(row => row.closing.debit))), credit: money(sum(trialBalance.map(row => row.closing.credit))) },
  };
  for (const total of Object.values(trialTotals)) if (total.debit !== total.credit) {
    throw new DomainError("UNBALANCED_REPORT", "Scoped ledger aggregates do not balance exactly.");
  }
  const closingNet = (row: AccountMovementValue) => decimal(row.openingDebit).minus(row.openingCredit).plus(row.periodDebit).minus(row.periodCredit);
  const bySection = (section: AccountMovementValue["statementSection"]) => rows.filter(row => row.statementSection === section)
    .reduce((total, row) => total.plus(closingNet(row)), new Exact(0));
  const revenue = sum(rows.filter(row => row.type === "revenue").map(row => row.periodCredit)).minus(sum(rows.filter(row => row.type === "revenue").map(row => row.periodDebit)));
  const expenses = sum(rows.filter(row => row.type === "expense").map(row => row.periodDebit)).minus(sum(rows.filter(row => row.type === "expense").map(row => row.periodCredit)));
  const result = revenue.minus(expenses);
  const currentYearResult = rows.filter(row => row.type === "revenue" || row.type === "expense")
    .reduce((total, row) => total.plus(row.yearCredit).minus(row.yearDebit), new Exact(0));
  const untransferredResult = bySection("revenue").plus(bySection("expenses")).negated();
  const priorUnclosedResult = untransferredResult.minus(currentYearResult);
  const assets = bySection("assets"), liabilities = bySection("liabilities").negated(), postedEquity = bySection("equity").negated();
  const equity = postedEquity.plus(currentYearResult).plus(priorUnclosedResult);
  const difference = assets.minus(liabilities).minus(equity);
  if (!difference.isZero()) throw new DomainError("UNBALANCED_REPORT", "Assets and liabilities plus equity do not balance exactly.");
  return {
    trialBalance: { rows: trialBalance, totals: trialTotals },
    // No invented direct-cost/income-tax split: current mappings provide only
    // revenue/expense sections. Final P&L classification is a separate gate.
    incomeMovement: { revenue: money(revenue), expenses: money(expenses), result: money(result) },
    balanceSheet: { assets: money(assets), liabilities: money(liabilities), postedEquity: money(postedEquity),
      currentYearResult: money(currentYearResult), priorUnclosedResult: money(priorUnclosedResult), equity: money(equity), difference: money(difference) },
  };
}
