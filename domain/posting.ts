import { z } from "zod";
import { CalendarDate } from "./finance-setup";
import { decimal, money } from "./money";
import { validateJournal } from "./accounting";

const Amount = z.string().refine(value => {
  try { return !decimal(value).isNegative(); } catch { return false; }
}, "Use a nonnegative decimal string with at most two decimal places.").transform(value => money(value));

// Additional dimensions fail closed until their scoped masters exist.
export const PostingLine = z.strictObject({
  accountId: z.uuid(), accountVersion: z.number().int().min(1).max(2147483647),
  debit: Amount, credit: Amount,
  dimensions: z.strictObject({ branchId: z.uuid().optional() }).default({}),
});
export const ManualPosting = z.strictObject({
  postingDate: CalendarDate, documentDate: CalendarDate,
  description: z.string().trim().min(1).max(1000), currency: z.literal("NPR"),
  lines: z.array(PostingLine).min(2).max(500),
});
export type ManualPostingInput = z.infer<typeof ManualPosting>;
export function prepareManualPosting(value: unknown) {
  const posting = ManualPosting.parse(value);
  return { posting, totals: validateJournal(posting.lines) };
}
