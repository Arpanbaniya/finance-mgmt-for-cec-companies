import { decimal, Exact, money } from "./money";
import { DomainError } from "./errors";

export type JournalLine = { accountId: string; debit: string; credit: string };
export function validateJournal(lines: JournalLine[]): { debit: string; credit: string } {
  if (lines.length < 2 || lines.length > 500) throw new DomainError("INVALID_JOURNAL", "A journal needs between two and 500 lines.");
  let debit = new Exact(0), credit = new Exact(0);
  for (const line of lines) {
    const d = decimal(line.debit), c = decimal(line.credit);
    if (d.isNegative() || c.isNegative() || d.isZero() === c.isZero()) throw new DomainError("INVALID_JOURNAL_LINE", "Each line has exactly one positive side.");
    debit = debit.plus(d); credit = credit.plus(c);
  }
  if (!debit.equals(credit)) throw new DomainError("UNBALANCED_JOURNAL", "Journal debits and credits must match exactly.");
  return { debit: money(debit), credit: money(credit) };
}
export function reverseLines(lines: JournalLine[]): JournalLine[] {
  validateJournal(lines);
  return lines.map(l => ({ accountId: l.accountId, debit: l.credit, credit: l.debit }));
}
