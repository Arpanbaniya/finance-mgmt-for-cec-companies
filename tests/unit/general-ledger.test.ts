import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { LedgerCursor, LedgerQuery, calculateLedgerPage, type LedgerLineValue } from "@/domain/general-ledger";
import { decodeLedgerCursor, encodeLedgerCursor } from "@/features/reporting/ledger-cursor";
const org = randomUUID(), entity = randomUUID(), account = randomUUID(), journal = randomUUID(), source = randomUUID();
const query = { accountId: account, fromDate: "2026-01-01", toDateExclusive: "2027-01-01" };
const cursor = { version: 1 as const, organizationId: org, entityId: entity, ...query, knownAt: "2026-10-11T01:02:03.123456Z", postingDate: "2026-02-01", journalId: journal, ordinal: 1 };
const line = (ordinal = 1, debit = "0.01", credit = "0.00"): LedgerLineValue => ({ journalId: journal, ordinal, postingDate: "2026-02-01", documentDate: "2026-01-31", recordedAt: cursor.knownAt,
  accountVersion: 1, accountCode: "ACCOUNT", accountName: "Retained name", debit, credit, source: { type: "journal", id: source, eventKind: "post" }, manualJournalId: null });
it("calculates exact page-prefix running balances, including credit balances", () => {
  expect(calculateLedgerPage("-0.02", [line(1), line(3), line(5, "0.00", "0.01")])).toMatchObject({ rows: [{ runningBalance: "-0.01" }, { runningBalance: "0.00" }, { runningBalance: "-0.01" }], endingBalance: "-0.01" });
});
it("keeps a paise beyond Number's safe integer range and rejects overflow", () => {
  expect(calculateLedgerPage("9007199254740992.00", [line()]).endingBalance).toBe("9007199254740992.01");
  expect(() => calculateLedgerPage("999999999999999999.99", [line()])).toThrow("supported range");
});
it("rejects duplicate or out-of-order positions and invalid one-sided ledger lines", () => {
  for (const rows of [[line(), line()], [line(3), line(1)]]) expect(() => calculateLedgerPage("0.00", rows)).toThrow("distinct ascending");
  expect(() => calculateLedgerPage("0.00", [{ ...line(), postingDate: "2026-03-01" }, line(3)])).toThrow("ascending");
  for (const row of [line(1, "0.00", "0.00"), line(1, "0.01", "0.01")]) expect(() => calculateLedgerPage("0.00", [row])).toThrow("one positive");
});
it("requires source identity agreement for manual journal detail references", () => {
  expect(calculateLedgerPage("0.00", [{ ...line(), manualJournalId: source }]).rows[0].manualJournalId).toBe(source);
  expect(() => calculateLedgerPage("0.00", [{ ...line(), manualJournalId: randomUUID() }])).toThrow("retained journal source");
  expect(() => calculateLedgerPage("0.00", [{ ...line(), source: { type: "invoice", id: source, eventKind: "post" }, manualJournalId: source }])).toThrow("retained journal source");
});
it("round-trips the complete scoped cursor without losing timestamp microseconds", () => {
  const encoded = encodeLedgerCursor(cursor);
  expect(decodeLedgerCursor(encoded, org.toUpperCase(), entity.toUpperCase(), LedgerQuery.parse(query))).toEqual(cursor);
  expect(decodeLedgerCursor(encoded, org, entity, LedgerQuery.parse({ ...query, knownAt: cursor.knownAt })).knownAt).toBe(cursor.knownAt);
});
it("rejects cross-entity/account/date/cutoff reuse while allowing a different bounded page size", () => {
  const encoded = encodeLedgerCursor(cursor);
  expect(decodeLedgerCursor(encoded, org, entity, LedgerQuery.parse({ ...query, limit: 100 }))).toEqual(cursor);
  for (const patch of [{ accountId: randomUUID() }, { fromDate: "2026-01-02" }, { toDateExclusive: "2026-12-31" }, { knownAt: "2026-10-11T01:02:03.123457Z" }]) {
    expect(() => decodeLedgerCursor(encoded, org, entity, LedgerQuery.parse({ ...query, ...patch }))).toThrow("same entity");
  }
  expect(() => decodeLedgerCursor(encoded, randomUUID(), entity, LedgerQuery.parse(query))).toThrow("same entity");
  expect(() => decodeLedgerCursor(encoded, org, randomUUID(), LedgerQuery.parse(query))).toThrow("same entity");
});
it("rejects malformed, noncanonical and extra-field cursors rather than accepting a supplied balance", () => {
  const bad = ["!", "a", "a".repeat(2049), Buffer.from("not JSON").toString("base64url"), encodeLedgerCursor(cursor) + "=",
    Buffer.from(JSON.stringify({ ...cursor, balance: "99999.00" })).toString("base64url")];
  for (const value of bad) expect(() => decodeLedgerCursor(value, org, entity, LedgerQuery.parse(query))).toThrow("valid cursor");
});
it("requires a visible-interval position, supported version, strict dates and a bounded query", () => {
  expect(LedgerQuery.parse(query).limit).toBe(25);
  for (const limit of [0, 101, 1.5, "25"]) expect(LedgerQuery.safeParse({ ...query, limit }).success).toBe(false);
  expect(LedgerQuery.safeParse({ ...query, dimension: randomUUID() }).success).toBe(false);
  expect(LedgerCursor.safeParse({ ...cursor, version: 2 }).success).toBe(false);
  expect(LedgerCursor.safeParse({ ...cursor, postingDate: query.toDateExclusive }).success).toBe(false);
  expect(LedgerCursor.safeParse({ ...cursor, ordinal: 501 }).success).toBe(false);
});
it("preserves an empty page prefix and refuses more than one hundred returned lines", () => {
  expect(calculateLedgerPage("10.00", [])).toEqual({ rows: [], endingBalance: "10.00" });
  expect(() => calculateLedgerPage("0.00", Array.from({ length: 101 }, (_, index) => line(index + 1)))).toThrow();
});
