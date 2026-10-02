import { z } from "zod";
import { businessDate } from "./dates";
import { decimal } from "./money";

// Only protected actions present in the R1 API catalog can select a policy.
export const approvalPermissions = {
  journal: "journals.approve", invoice: "invoices.approve", bill: "bills.approve",
  credit_note: "credit_notes.approve", settlement: "settlements.approve", transfer: "transfers.approve",
  expense: "expenses.approve", period_reopen_request: "periods.approve", reconciliation: "banking.approve",
  rate_version: "rates.approve", worker_private_change: "worker_private.approve", bank_private_change: "bank_private.approve",
  attendance: "attendance.approve", attendance_adjustment: "attendance.approve", advance: "advances.approve",
  payroll_run: "payroll.approve", billing_run: "billing.approve", import: "imports.approve", opening_batch: "opening.approve",
} as const;
export type AggregateType = keyof typeof approvalPermissions;
export const AggregateTypeSchema = z.enum(Object.keys(approvalPermissions) as [AggregateType, ...AggregateType[]]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { try { businessDate(value); return true; } catch { return false; } }, "Use a valid business date.");
const amount = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/).refine(value => { try { return !decimal(value).isNegative(); } catch { return false; } }, "Use a nonnegative decimal string within the money limit.");
export const ApprovalThreshold = z.strictObject({
  minInclusive: amount, maxExclusive: amount.optional(),
  requiredPermission: z.enum([...new Set(Object.values(approvalPermissions))] as [string, ...string[]]),
  numberOfDistinctApprovers: z.number().int().min(1).max(10),
});
export const ApprovalPolicyFields = z.strictObject({
  name: z.string().trim().min(1).max(200), effectiveFrom: date, effectiveTo: date.optional(),
  aggregateTypes: z.array(AggregateTypeSchema).min(1).max(19), currency: z.literal("NPR"),
  thresholds: z.array(ApprovalThreshold).min(1).max(50), makerChecker: z.literal(true),
});
export const ApprovalPolicyCreate = ApprovalPolicyFields.superRefine((value, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  if (value.effectiveTo && value.effectiveTo <= value.effectiveFrom) issue(["effectiveTo"], "End date must be after start; the end is exclusive.");
  if (new Set(value.aggregateTypes).size !== value.aggregateTypes.length) issue(["aggregateTypes"], "Aggregate types must be distinct.");
  let next = "0";
  value.thresholds.forEach((row, index) => {
    if (!amount.safeParse(row.minInclusive).success || (row.maxExclusive !== undefined && !amount.safeParse(row.maxExclusive).success)) return;
    if (next === "unbounded" || !decimal(row.minInclusive).equals(decimal(next))) issue(["thresholds", index, "minInclusive"], "Ranges must be ordered, adjacent and cover every amount from zero.");
    if (row.maxExclusive !== undefined && !decimal(row.maxExclusive).greaterThan(decimal(row.minInclusive))) issue(["thresholds", index, "maxExclusive"], "Upper bound must exceed lower bound.");
    if (value.aggregateTypes.some(type => row.requiredPermission !== approvalPermissions[type])) issue(["thresholds", index, "requiredPermission"], "Permission must match every selected protected action.");
    next = row.maxExclusive ?? "unbounded";
  });
  if (next !== "unbounded") issue(["thresholds"], "The final range must be unbounded.");
});
export type PolicyDefinition = z.infer<typeof ApprovalPolicyCreate>;
