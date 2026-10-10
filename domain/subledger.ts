import { z } from "zod";
import { CalendarDate } from "./finance-setup";
import { decimal, Exact, money } from "./money";
import { DomainError } from "./errors";

const Amount = z.string().refine(value => {
  try { return !decimal(value).isNegative(); } catch { return false; }
}, "Use a nonnegative exact decimal string.").transform(value => money(value));
const PositiveAmount = Amount.refine(value => decimal(value).greaterThan(0), "Amount must be positive.");
// UTC instants retain PostgreSQL's microseconds; comparing normalized strings
// avoids losing the close watermark's final three digits to JavaScript Date.
const Instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/).refine(value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 23) === value.slice(0, 23)
    && CalendarDate.safeParse(value.slice(0, 10)).success;
}, "Use a valid UTC instant with six fractional digits.");
const Side = z.enum(["ar", "ap"]);

/** Internal evidence loaded by a trusted source adapter, never an HTTP body. */
export const SubledgerLine = z.strictObject({
  organizationId: z.uuid(), entityId: z.uuid(), currency: z.literal("NPR"),
  journalId: z.uuid(), ordinal: z.number().int().min(1).max(500),
  sourceType: z.enum(["invoice", "bill", "settlement", "opening_batch"]), sourceId: z.uuid(),
  eventKind: z.enum(["post", "reverse"]), postingDate: CalendarDate, recordedAt: Instant,
  accountId: z.uuid(), accountVersion: z.number().int().min(1).max(2147483647),
  controlType: z.enum(["ar", "ap", "customer_deposits", "supplier_advances"]),
  debit: Amount, credit: Amount,
}).refine(value => decimal(value.debit).greaterThan(0) !== decimal(value.credit).greaterThan(0), "Use one positive journal side.");
export const OpenItem = z.strictObject({
  id: z.uuid(), side: Side, partyId: z.uuid(), amount: PositiveAmount,
  documentDate: CalendarDate, dueDate: CalendarDate, line: SubledgerLine,
});
export const SettlementCapacity = z.strictObject({
  id: z.uuid(), side: Side, partyId: z.uuid(), amount: PositiveAmount,
  mode: z.enum(["direct", "on_account"]), line: SubledgerLine,
});
const Apply = z.strictObject({
  kind: z.literal("apply"), id: z.uuid(), sourceSettlementId: z.uuid(), targetOpenItemId: z.uuid(),
  amount: PositiveAmount, effectiveDate: CalendarDate, recordedAt: Instant, line: SubledgerLine,
});
const Reverse = z.strictObject({
  kind: z.literal("reverse"), id: z.uuid(), reversalOf: z.uuid(),
  effectiveDate: CalendarDate, recordedAt: Instant, line: SubledgerLine,
});
export const AllocationEvent = z.discriminatedUnion("kind", [Apply, Reverse]);
export const SubledgerHistory = z.strictObject({
  organizationId: z.uuid(), entityId: z.uuid(), currency: z.literal("NPR"),
  openItems: z.array(OpenItem), settlements: z.array(SettlementCapacity), events: z.array(AllocationEvent),
});
export const SubledgerCutoff = z.strictObject({ asOfDate: CalendarDate, knownAt: Instant });
export type SubledgerHistoryInput = z.input<typeof SubledgerHistory>;
export type SubledgerHistoryValue = z.output<typeof SubledgerHistory>;
export type AllocationEventInput = z.input<typeof AllocationEvent>;
type Line = z.output<typeof SubledgerLine>;
type Application = z.output<typeof Apply>;
type Reversal = z.output<typeof Reverse>;
type History = SubledgerHistoryValue;

function fail(code: string, message: string): never { throw new DomainError(code, message); }
function lineKey(line: Line) { return `${line.journalId}:${line.ordinal}`; }
function lineAmount(line: Line) { return decimal(line.debit).plus(decimal(line.credit)); }
function matchesSide(line: Line, side: "ar" | "ap", opening: boolean) {
  return opening === (side === "ar") ? decimal(line.debit).greaterThan(0) : decimal(line.credit).greaterThan(0);
}
function scope(history: History, line: Line) {
  if (line.organizationId !== history.organizationId || line.entityId !== history.entityId || line.currency !== history.currency)
    fail("SUBLEDGER_SCOPE_MISMATCH", "Journal evidence must belong to the same entity and currency.");
}
function distinct(values: string[], message: string) {
  if (new Set(values).size !== values.length) fail("DUPLICATE_SUBLEDGER_SOURCE", message);
}
function sameLine(a: Line, b: Line) {
  // A shared direct-settlement line must be the very same retained evidence.
  return Object.keys(a).every(key => a[key as keyof Line] === b[key as keyof Line]);
}
function compareEvents(a: Application | Reversal, b: Application | Reversal) {
  return a.effectiveDate.localeCompare(b.effectiveDate) || a.recordedAt.localeCompare(b.recordedAt)
    || (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === "apply" ? -1 : 1);
}
function usage(history: History, events: (Application | Reversal)[], order: "business" | "recorded" = "business") {
  const applications = new Map(history.events.filter(event => event.kind === "apply").map(event => [event.id, event]));
  const targets = new Map(history.openItems.map(item => [item.id, new Exact(0)]));
  const sources = new Map(history.settlements.map(item => [item.id, new Exact(0)]));
  const targetAmounts = new Map(history.openItems.map(item => [item.id, decimal(item.amount)]));
  const sourceAmounts = new Map(history.settlements.map(item => [item.id, decimal(item.amount)]));
  const ordered = [...events].sort(order === "business" ? compareEvents : (a, b) => a.recordedAt.localeCompare(b.recordedAt) || compareEvents(a, b));
  for (const event of ordered) {
    const application = event.kind === "apply" ? event : applications.get(event.reversalOf)!;
    const amount = decimal(application.amount).times(event.kind === "apply" ? 1 : -1);
    const target = targets.get(application.targetOpenItemId)!.plus(amount);
    const source = sources.get(application.sourceSettlementId)!.plus(amount);
    if (target.isNegative() || source.isNegative() || target.greaterThan(targetAmounts.get(application.targetOpenItemId)!)
      || source.greaterThan(sourceAmounts.get(application.sourceSettlementId)!))
      fail("OVER_ALLOCATION", "Allocation history exceeds a source or target balance at a business-date cut-off.");
    targets.set(application.targetOpenItemId, target); sources.set(application.sourceSettlementId, source);
  }
  return { targets, sources };
}

/** Pure consistency gate. It cannot prove persisted authorization or RLS. */
export function validateSubledgerHistory(value: unknown): History {
  const history = SubledgerHistory.parse(value);
  distinct([...history.openItems.map(item => item.id), ...history.settlements.map(item => item.id), ...history.events.map(event => event.id)],
    "Subledger record IDs must be distinct.");
  distinct(history.openItems.map(item => lineKey(item.line)), "One opening journal line cannot create duplicate open balances.");
  distinct(history.settlements.map(item => lineKey(item.line)), "One settlement line cannot create duplicate capacity.");
  const items = new Map(history.openItems.map(item => [item.id, item]));
  const settlements = new Map(history.settlements.map(item => [item.id, item]));
  const applications = new Map(history.events.filter(event => event.kind === "apply").map(event => [event.id, event]));
  const reversals = history.events.filter(event => event.kind === "reverse");
  distinct(reversals.map(event => event.reversalOf), "An allocation may be reversed only once.");
  const exclusiveLines = new Set(history.openItems.map(item => lineKey(item.line)));
  for (const item of history.openItems) {
    scope(history, item.line);
    if (item.line.eventKind !== "post" || item.line.controlType !== item.side || !matchesSide(item.line, item.side, true)
      || !lineAmount(item.line).equals(item.amount)
      || ![item.side === "ar" ? "invoice" : "bill", "opening_batch"].includes(item.line.sourceType))
      fail("SUBLEDGER_LINK_MISMATCH", "Open amount must equal its originating AR/AP control line.");
  }
  for (const settlement of history.settlements) {
    scope(history, settlement.line);
    const control = settlement.mode === "direct" ? settlement.side : settlement.side === "ar" ? "customer_deposits" : "supplier_advances";
    if (settlement.line.sourceType !== "settlement" || settlement.line.sourceId !== settlement.id || settlement.line.eventKind !== "post"
      || settlement.line.controlType !== control || !matchesSide(settlement.line, settlement.side, false)
      || !lineAmount(settlement.line).equals(settlement.amount))
      fail("SUBLEDGER_LINK_MISMATCH", "Settlement capacity must equal its retained settlement control line.");
    if (exclusiveLines.has(lineKey(settlement.line))) fail("DUPLICATE_SUBLEDGER_SOURCE", "Journal evidence is already consumed.");
    exclusiveLines.add(lineKey(settlement.line));
  }
  for (const event of history.events) {
    scope(history, event.line);
    if (event.line.postingDate !== event.effectiveDate || event.line.recordedAt !== event.recordedAt)
      fail("SUBLEDGER_LINK_MISMATCH", "Allocation date and recorded evidence must agree with its journal.");
    if (event.kind === "apply") {
      const item = items.get(event.targetOpenItemId), source = settlements.get(event.sourceSettlementId);
      if (!item || !source) fail("SUBLEDGER_REFERENCE_MISSING", "Allocation requires an existing scoped source and target.");
      if (item.partyId !== source.partyId || item.side !== source.side)
        fail("SUBLEDGER_SCOPE_MISMATCH", "Allocation cannot cross counterparty or AR/AP side.");
      if (event.line.accountId !== item.line.accountId)
        fail("SUBLEDGER_LINK_MISMATCH", "Allocation must settle the target's retained control account.");
      if (event.effectiveDate < item.line.postingDate || event.effectiveDate < source.line.postingDate
        || event.recordedAt < item.line.recordedAt || event.recordedAt < source.line.recordedAt)
        fail("SUBLEDGER_DATE_MISMATCH", "Allocation cannot precede its source or target.");
      if (source.mode === "direct") {
        if (!sameLine(event.line, source.line)) fail("SUBLEDGER_LINK_MISMATCH", "Direct allocation uses its original settlement control line only.");
      } else {
        if (event.line.sourceType !== "settlement" || event.line.eventKind !== "post" || event.line.controlType !== item.side
          || !matchesSide(event.line, item.side, false) || !lineAmount(event.line).equals(event.amount)
          || event.line.journalId === source.line.journalId)
          fail("SUBLEDGER_LINK_MISMATCH", "Deposit or advance application requires a separate exact AR/AP reclassification line.");
        if (exclusiveLines.has(lineKey(event.line))) fail("DUPLICATE_SUBLEDGER_SOURCE", "Journal evidence is already consumed.");
        exclusiveLines.add(lineKey(event.line));
      }
    } else {
      const original = applications.get(event.reversalOf);
      if (!original) fail("SUBLEDGER_REFERENCE_MISSING", "Reversal must reference an original application, not another reversal.");
      const target = items.get(original.targetOpenItemId)!;
      if (event.effectiveDate < original.effectiveDate || event.recordedAt < original.recordedAt)
        fail("SUBLEDGER_DATE_MISMATCH", "Reversal cannot precede its original application.");
      if (event.line.sourceType !== "settlement" || event.line.eventKind !== "reverse" || event.line.controlType !== target.side
        || event.line.accountId !== original.line.accountId || event.line.accountVersion !== original.line.accountVersion
        || !matchesSide(event.line, target.side, true)
        || !lineAmount(event.line).equals(original.amount) || event.line.journalId === original.line.journalId)
        fail("SUBLEDGER_LINK_MISMATCH", "Allocation reversal requires a new exact inverse control line.");
      if (exclusiveLines.has(lineKey(event.line))) fail("DUPLICATE_SUBLEDGER_SOURCE", "Journal evidence is already consumed.");
      exclusiveLines.add(lineKey(event.line));
    }
  }
  // Direct postings cannot leave a phantom unapplied balance: their whole
  // control line was already settled, unlike a deposit/advance posting.
  for (const source of history.settlements.filter(item => item.mode === "direct")) {
    const total = history.events.filter(event => event.kind === "apply" && event.sourceSettlementId === source.id)
      .reduce((sum, event) => sum.plus((event as Application).amount), new Exact(0));
    if (!total.equals(source.amount)) fail("DIRECT_SETTLEMENT_INCOMPLETE", "Direct settlement must allocate its exact full amount at posting.");
  }
  usage(history, history.events);
  usage(history, history.events, "recorded");
  return history;
}

export function subledgerAt(value: unknown, cutoff: unknown) {
  const history = validateSubledgerHistory(value), { asOfDate, knownAt } = SubledgerCutoff.parse(cutoff);
  const visible = (date: string, instant: string) => date <= asOfDate && instant <= knownAt;
  const events = history.events.filter(event => visible(event.effectiveDate, event.recordedAt));
  const { targets, sources } = usage(history, events);
  return {
    organizationId: history.organizationId, entityId: history.entityId, currency: history.currency, asOfDate, knownAt,
    openItems: history.openItems.filter(item => visible(item.line.postingDate, item.line.recordedAt)).map(item => {
      const applied = targets.get(item.id)!;
      return { id: item.id, partyId: item.partyId, side: item.side, dueDate: item.dueDate,
        originalAmount: item.amount, allocatedAmount: money(applied), outstandingAmount: money(decimal(item.amount).minus(applied)),
        status: applied.isZero() ? "open" as const : applied.equals(item.amount) ? "settled" as const : "partial" as const };
    }),
    settlements: history.settlements.filter(item => visible(item.line.postingDate, item.line.recordedAt)).map(item => {
      const applied = sources.get(item.id)!;
      // Reversing a direct settlement reopens the target, not a deposit balance.
      return { id: item.id, partyId: item.partyId, side: item.side, mode: item.mode, originalAmount: item.amount,
        allocatedAmount: money(applied), unappliedAmount: sourceUnapplied(item, applied) };
    }),
  };
}
function sourceUnapplied(source: z.output<typeof SettlementCapacity>, applied: InstanceType<typeof Exact>) {
  return source.mode === "direct" ? "0.00" : money(decimal(source.amount).minus(applied));
}

/** Plan only: the adapter must lock, authorize, post and persist atomically. */
export function appendAllocationEvents(value: unknown, additions: readonly AllocationEventInput[]): History {
  const history = validateSubledgerHistory(value);
  return validateSubledgerHistory({ ...history, events: [...history.events, ...additions] });
}
