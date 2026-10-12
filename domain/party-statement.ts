import { z } from "zod";
import { CalendarDate } from "./finance-setup";
import { ReportInstant, StatementAmount, SignedStatementAmount } from "./statements";
import { decimal, money } from "./money";
import { DomainError } from "./errors";

export const StatementQuery = z.strictObject({
  asOfDate: CalendarDate, fromDate: CalendarDate.default("1900-01-01"), knownAt: ReportInstant.optional(),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).refine(q => q.fromDate <= q.asOfDate, "The start must not follow the inclusive as-of date.");
export const PartyStatementBook = z.enum(["ar", "ap", "customer_deposits", "supplier_advances"]);
export const PartyStatementComponent = z.strictObject({
  book: PartyStatementBook, opening: StatementAmount, increases: StatementAmount, decreases: StatementAmount,
  closing: StatementAmount, subledgerOpening: StatementAmount, subledgerClosing: StatementAmount,
});
export const PartyAgeing = z.strictObject({
  side: z.enum(["ar", "ap"]), current: StatementAmount, days1To30: StatementAmount,
  days31To60: StatementAmount, days61To90: StatementAmount, daysOver90: StatementAmount,
});
export const PartyStatementActivity = z.strictObject({
  sourceId: z.uuid(), journalId: z.uuid(),
  kind: z.enum(["ar_item", "ap_item", "ar_deposit", "ap_advance", "ar_direct", "ap_direct", "application", "allocation_reverse"]),
  postingDate: CalendarDate, documentDate: CalendarDate, recordedAt: ReportInstant, amount: StatementAmount,
  effects: z.strictObject({ ar: SignedStatementAmount, ap: SignedStatementAmount,
    customer_deposits: SignedStatementAmount, supplier_advances: SignedStatementAmount }),
});
export const PartyStatementCursor = z.strictObject({
  version: z.literal(1), organizationId: z.uuid(), entityId: z.uuid(), partyId: z.uuid(),
  fromDate: CalendarDate, asOfDate: CalendarDate, knownAt: ReportInstant, postingDate: CalendarDate, sourceId: z.uuid(),
}).refine(c => c.fromDate <= c.postingDate && c.postingDate <= c.asOfDate, "Cursor must belong to the interval.");

/** Independent retained-ledger/subledger reconciliation; never silently net books. */
export function reconcilePartyStatement(components: unknown, ageing: unknown) {
  const balances = z.array(PartyStatementComponent).length(4).parse(components);
  const aged = z.array(PartyAgeing).length(2).parse(ageing);
  if (new Set(balances.map(b => b.book)).size !== 4 || new Set(aged.map(a => a.side)).size !== 2)
    throw new DomainError("INVALID_PARTY_STATEMENT", "Statement books must be distinct.");
  for (const b of balances) {
    if (money(decimal(b.opening).plus(b.increases).minus(b.decreases)) !== b.closing
      || b.opening !== b.subledgerOpening || b.closing !== b.subledgerClosing)
      throw new DomainError("PARTY_STATEMENT_MISMATCH", "Party control and subledger balances do not reconcile; no partial statement is returned.");
  }
  for (const a of aged) {
    const sum = decimal(a.current).plus(a.days1To30).plus(a.days31To60).plus(a.days61To90).plus(a.daysOver90);
    if (money(sum) !== balances.find(b => b.book === a.side)!.closing)
      throw new DomainError("PARTY_STATEMENT_MISMATCH", "Party ageing does not reconcile to its outstanding balance.");
  }
  return { balances, ageing: aged };
}
