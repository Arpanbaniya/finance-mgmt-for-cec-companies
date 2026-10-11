import { z } from "zod";
import { CalendarDate } from "./finance-setup";
import { ReportInstant, SignedStatementAmount, StatementAmount } from "./statements";
import { decimal, money } from "./money";
import { DomainError } from "./errors";

const ID = z.uuid().toLowerCase();
export const LedgerQuery = z.strictObject({ accountId: ID, fromDate: CalendarDate, toDateExclusive: CalendarDate,
  knownAt: ReportInstant.optional(), limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).refine(value => value.fromDate < value.toDateExclusive, "The exclusive end must follow the start date.");
export const LedgerCursor = z.strictObject({ version: z.literal(1), organizationId: ID, entityId: ID, accountId: ID,
  fromDate: CalendarDate, toDateExclusive: CalendarDate, knownAt: ReportInstant,
  postingDate: CalendarDate, journalId: ID, ordinal: z.number().int().min(1).max(500),
}).refine(value => value.fromDate <= value.postingDate && value.postingDate < value.toDateExclusive, "Cursor anchor must belong to its report interval.");
export type LedgerCursorValue = z.infer<typeof LedgerCursor>;
export const LedgerLine = z.strictObject({ journalId: ID, ordinal: z.number().int().min(1).max(500), postingDate: CalendarDate,
  documentDate: CalendarDate, recordedAt: ReportInstant, accountVersion: z.number().int().positive(),
  accountCode: z.string().min(1).max(100), accountName: z.string().min(1).max(200), debit: StatementAmount, credit: StatementAmount,
  source: z.strictObject({ type: z.enum(["journal", "invoice", "bill", "settlement"]), id: ID, eventKind: z.literal("post") }),
  manualJournalId: ID.nullable(),
});
export type LedgerLineValue = z.infer<typeof LedgerLine>;
export function compareLedgerPosition(left: Pick<LedgerLineValue, "postingDate" | "journalId" | "ordinal">, right: Pick<LedgerLineValue, "postingDate" | "journalId" | "ordinal">) {
  if (left.postingDate !== right.postingDate) return left.postingDate < right.postingDate ? -1 : 1;
  if (left.journalId !== right.journalId) return left.journalId < right.journalId ? -1 : 1;
  return left.ordinal - right.ordinal;
}
export function bindLedgerCursor(value: unknown, organizationId: string, entityId: string, query: z.infer<typeof LedgerQuery>) {
  const cursor = LedgerCursor.parse(value);
  if (cursor.organizationId !== organizationId.toLowerCase() || cursor.entityId !== entityId.toLowerCase() || cursor.accountId !== query.accountId
    || cursor.fromDate !== query.fromDate || cursor.toDateExclusive !== query.toDateExclusive || (query.knownAt && cursor.knownAt !== query.knownAt)) {
    throw new DomainError("INVALID_CURSOR", "Use a cursor from the same entity, account, dates and knowledge cutoff.", 400);
  }
  return cursor;
}
export function calculateLedgerPage(precedingBalance: unknown, value: unknown) {
  let balance = decimal(SignedStatementAmount.parse(precedingBalance));
  const lines = z.array(LedgerLine).max(100).parse(value);
  const rows = lines.map((line, index) => {
    if (index && compareLedgerPosition(lines[index - 1], line) >= 0) throw new DomainError("INVALID_LEDGER_ORDER", "Ledger rows must have distinct ascending date, journal and ordinal positions.");
    if (decimal(line.debit).greaterThan(0) === decimal(line.credit).greaterThan(0)) throw new DomainError("INVALID_LEDGER_LINE", "A posted ledger line must have one positive side.");
    if (line.manualJournalId && (line.source.type !== "journal" || line.manualJournalId !== line.source.id)) throw new DomainError("INVALID_LEDGER_SOURCE", "Manual drill-down must match the retained journal source.");
    balance = balance.plus(line.debit).minus(line.credit);
    return { ...line, runningBalance: money(balance) };
  });
  return { rows, endingBalance: money(balance) };
}
