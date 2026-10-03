import { z } from "zod";
import { businessDate } from "./dates";
export const CalendarDate = z.iso.date().refine(value => { try { businessDate(value); return true; } catch { return false; } }, "Use a supported AD calendar date.");
export const PeriodRange = z.strictObject({ startDate: CalendarDate, endDateExclusive: CalendarDate });
export const PeriodCreate = z.strictObject({ fiscalYearLabel: z.string().trim().min(1).max(100), periods: z.array(PeriodRange).min(1).max(24), retainedEarningsAccountId: z.uuid() }).superRefine((value, ctx) => {
  value.periods.forEach((period, index) => {
    if (period.startDate >= period.endDateExclusive) ctx.addIssue({ code: "custom", path: ["periods", index, "endDateExclusive"], message: "The exclusive end date must follow the start date." });
    if (index && period.startDate !== value.periods[index - 1].endDateExclusive) ctx.addIssue({ code: "custom", path: ["periods", index, "startDate"], message: "Enter periods in date order without gaps or overlap." });
  });
});
// Finite R1 posting roles. No rate or financial balance is configured here.
export const purposeRules = {
  ar: ["asset", "ar"], ap: ["liability", "ap"], cash: ["asset", "cash"], service_revenue: ["revenue", null], expense: ["expense", null],
  input_tax: ["asset", "tax_receivable"], output_tax: ["liability", "tax_payable"], withholding_receivable: ["asset", "tax_receivable"], withholding_payable: ["liability", "tax_payable"],
  customer_deposits: ["liability", "customer_deposits"], supplier_advances: ["asset", "supplier_advances"], worker_advances: ["asset", "worker_advances"],
  wages_expense: ["expense", null], employer_contribution_expense: ["expense", null], wages_payable: ["liability", "wages_payable"], statutory_payable: ["liability", "statutory_payable"],
  payroll_tax_payable: ["liability", "tax_payable"], staff_advances: ["asset", "staff_advances"], employee_reimbursements: ["liability", "employee_reimbursements"], bank_charges: ["expense", null],
  suspense_asset: ["asset", null], suspense_liability: ["liability", null], accrued_liability: ["liability", null], prepaid_asset: ["asset", null], retained_earnings: ["equity", null], rounding: ["expense", null],
} as const;
export type AccountPurpose = keyof typeof purposeRules;
export const AccountPurposeSchema = z.enum(Object.keys(purposeRules) as [AccountPurpose, ...AccountPurpose[]]);
export const MappingEntry = z.strictObject({ purpose: AccountPurposeSchema, accountId: z.uuid() });
export const AccountMappingsPatch = z.strictObject({ effectiveFrom: CalendarDate, mappings: z.array(MappingEntry).length(Object.keys(purposeRules).length), reason: z.string().trim().min(3).max(1000) }).superRefine((value, ctx) => {
  if (new Set(value.mappings.map(item => item.purpose)).size !== Object.keys(purposeRules).length) ctx.addIssue({ code: "custom", path: ["mappings"], message: "Supply each R1 account purpose exactly once." });
});
export function matchesPurpose(purpose: AccountPurpose, account: { type: string; controlType: string | null; active: boolean }) {
  const [type, controlType] = purposeRules[purpose]; return account.active && account.type === type && account.controlType === controlType;
}
export const DocumentType = z.enum(["journal", "invoice", "bill", "credit_note", "settlement", "transfer", "expense", "payroll_run", "opening_batch", "year_close", "worker_advance"]);
export const NumberRequest = z.strictObject({ documentType: DocumentType, sourceId: z.uuid(), eventKind: z.enum(["post", "reverse", "opening", "year_close"]), postingDate: CalendarDate });
