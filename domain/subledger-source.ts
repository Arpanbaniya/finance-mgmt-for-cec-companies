import { z } from "zod";
import { decimal, money } from "./money";
import { CalendarDate } from "./finance-setup";

const Amount = z.string().refine(value => {
  try { return decimal(value).greaterThan(0); } catch { return false; }
}, "Use a positive bounded decimal string.").transform(value => money(value));
const dates = { postingDate: CalendarDate, documentDate: CalendarDate };
const origin = { ...dates, partyId: z.uuid(), amount: Amount, controlAccountId: z.uuid(), counterAccountId: z.uuid() };
const allocation = z.strictObject({ openItemId: z.uuid(), amount: Amount });
// Trusted internal producer input, not an API request or approval bypass.
export const SubledgerSourceInput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ar_item"), ...origin, dueDate: CalendarDate }),
  z.strictObject({ kind: z.literal("ap_item"), ...origin, dueDate: CalendarDate }),
  z.strictObject({ kind: z.literal("ar_deposit"), ...origin }),
  z.strictObject({ kind: z.literal("ap_advance"), ...origin }),
  z.strictObject({ kind: z.literal("ar_direct"), ...origin, allocations: z.array(allocation).min(1).max(100) }),
  z.strictObject({ kind: z.literal("ap_direct"), ...origin, allocations: z.array(allocation).min(1).max(100) }),
  z.strictObject({ kind: z.literal("application"), ...dates, settlementId: z.uuid(), openItemId: z.uuid(), amount: Amount }),
  z.strictObject({ kind: z.literal("allocation_reverse"), ...dates, reversalOf: z.uuid(), reason: z.string().trim().min(3).max(1000) }),
]);
export type SubledgerSourceValue = z.input<typeof SubledgerSourceInput>;
