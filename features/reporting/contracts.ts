import { z } from "zod";
import { CalendarDate } from "@/domain/finance-setup";
import { AccountType } from "@/domain/accounts";
import { ReportInstant, SignedStatementAmount, StatementAmount } from "@/domain/statements";
import { LedgerLine } from "@/domain/general-ledger";

export const StatementMetadata = z.strictObject({ organizationId: z.uuid(), entityId: z.uuid(), currency: z.literal("NPR"),
  fromDate: CalendarDate, toDateExclusive: CalendarDate, asOfDate: CalendarDate, knownAt: ReportInstant, generatedAt: ReportInstant,
  ledgerWatermark: ReportInstant.nullable(), journalCount: z.string().regex(/^(0|[1-9]\d*)$/),
  fiscalYearId: z.uuid(), fiscalYearStart: CalendarDate, fiscalYearEndExclusive: CalendarDate,
  retainedEarningsAccountId: z.uuid(), retainedEarningsAccountVersion: z.number().int().positive(),
  reportingProfile: z.enum(["demo_accrual", "review_required"]), policyStatus: z.enum(["demo", "review_required"]),
  reportVersion: z.literal("statement-foundation-v2"), mappingBasis: z.literal("posted-account-versions"),
});
const MappingWitness = z.strictObject({ accountId: z.uuid(), accountVersion: z.number().int().positive(), code: z.string().min(1).max(100), name: z.string().min(1).max(200) });
export const ProfitLossResult = z.strictObject({ mappingComplete: z.boolean(), operatingRevenue: SignedStatementAmount, directCosts: SignedStatementAmount, operatingExpenses: SignedStatementAmount,
  otherIncome: SignedStatementAmount, financeCosts: SignedStatementAmount, incomeTaxExpense: SignedStatementAmount, unclassifiedRevenue: SignedStatementAmount, unclassifiedExpenses: SignedStatementAmount,
  grossProfit: SignedStatementAmount.nullable(), contributionMargin: SignedStatementAmount.nullable(), operatingProfit: SignedStatementAmount.nullable(), profitBeforeTax: SignedStatementAmount.nullable(), netProfit: SignedStatementAmount.nullable(),
  unclassifiedAccounts: z.array(MappingWitness).max(10000), missingCostBehavior: z.array(MappingWitness).max(10000) });
export const OwnerStatementMetadata = StatementMetadata.omit({ retainedEarningsAccountId: true, retainedEarningsAccountVersion: true, journalCount: true, reportVersion: true })
  .extend({ reportVersion: z.literal("owner-statement-summary-v1") });
export const OwnerStatementResult = z.strictObject({ metadata: OwnerStatementMetadata,
  profitLoss: ProfitLossResult.omit({ unclassifiedAccounts: true, missingCostBehavior: true }).extend({ contributionMappingComplete: z.boolean() }),
  incomeMovement: z.strictObject({ revenue: SignedStatementAmount, expenses: SignedStatementAmount, result: SignedStatementAmount }),
  balanceSheet: z.strictObject({ assets: SignedStatementAmount, liabilities: SignedStatementAmount, postedEquity: SignedStatementAmount,
    currentYearResult: SignedStatementAmount, priorUnclosedResult: SignedStatementAmount, equity: SignedStatementAmount, difference: z.literal("0.00") }),
  limitations: z.array(z.string().min(1)).max(10),
});
export const GeneralLedgerMetadata = StatementMetadata.extend({ reportVersion: z.literal("general-ledger-v1"), accountId: z.uuid(),
  balanceConvention: z.literal("debit-positive"), watermarkScope: z.literal("selected-account"),
});
export const GeneralLedgerResult = z.strictObject({ metadata: GeneralLedgerMetadata,
  account: z.strictObject({ id: z.uuid(), code: z.string().min(1).max(100), name: z.string().min(1).max(200), type: AccountType,
    normalSide: z.enum(["debit", "credit"]), headerVersion: z.number().int().positive(), nameBasis: z.literal("latest-visible-posted-version-or-initial") }),
  rows: z.array(LedgerLine.extend({ runningBalance: SignedStatementAmount })).max(100),
  totals: z.strictObject({ openingBalance: SignedStatementAmount, periodDebit: StatementAmount, periodCredit: StatementAmount,
    closingBalance: SignedStatementAmount, lineCount: z.string().regex(/^(0|[1-9]\d*)$/) }),
  page: z.strictObject({ precedingBalance: SignedStatementAmount, endingBalance: SignedStatementAmount, nextCursor: z.string().max(2048).nullable() }),
  limitations: z.array(z.string()).max(10),
});
