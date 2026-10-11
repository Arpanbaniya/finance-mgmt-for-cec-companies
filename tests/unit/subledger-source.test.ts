import { expect, it } from "vitest";
import { SubledgerSourceInput } from "@/domain/subledger-source";
import { BalanceQuery, OpenBalance } from "@/features/accounting/subledger-service";

const id = "00000000-0000-4000-8000-000000000001";
const dates = { postingDate: "2026-02-01", documentDate: "2026-01-31" };
const origin = { ...dates, partyId: id, amount: "1.01", controlAccountId: id, counterAccountId: id };
const item = { ...origin, kind: "ar_item", dueDate: "2026-02-28" };
const query = { asOfDate: "2026-12-31", knownAt: "2026-12-31T23:59:59.123456Z" };

it.each(["ar_item", "ap_item", "ar_deposit", "ap_advance", "ar_direct", "ap_direct", "application", "allocation_reverse"])("accepts only the finite internal %s input", kind => {
  const input = kind.endsWith("item") ? { ...item, kind }
    : kind.endsWith("direct") ? { ...origin, kind, allocations: [{ openItemId: id, amount: "1.01" }] }
    : kind === "application" ? { ...dates, kind, settlementId: id, openItemId: id, amount: "1.01" }
    : kind === "allocation_reverse" ? { ...dates, kind, reversalOf: id, reason: " Fictional correction " }
    : { ...origin, kind };
  expect(SubledgerSourceInput.parse(input).kind).toBe(kind);
});
it("normalizes exact strings without accepting numeric money or extra authority", () => {
  expect(SubledgerSourceInput.parse({ ...item, amount: "1" })).toMatchObject({ amount: "1.00" });
  expect(SubledgerSourceInput.parse({ ...item, amount: "999999999999999999.99" })).toMatchObject({ amount: "999999999999999999.99" });
  for (const amount of [1, "0", "-1", "0.001", "1e3", "Infinity", "NaN", "1000000000000000000.00"])
    expect(SubledgerSourceInput.safeParse({ ...item, amount }).success).toBe(false);
  for (const key of ["actorId", "accountVersion", "journalId", "recordedAt", "status", "currency", "organizationId"])
    expect(SubledgerSourceInput.safeParse({ ...item, [key]: id }).success).toBe(false);
});
it("validates strict nested allocation bounds, dates and inverse reasons", () => {
  const direct = { ...origin, kind: "ar_direct", allocations: [{ openItemId: id, amount: "1.01" }] };
  expect(SubledgerSourceInput.safeParse({ ...direct, allocations: [] }).success).toBe(false);
  expect(SubledgerSourceInput.safeParse({ ...direct, allocations: Array.from({ length: 101 }, () => direct.allocations[0]) }).success).toBe(false);
  expect(SubledgerSourceInput.safeParse({ ...direct, allocations: [{ ...direct.allocations[0], paid: true }] }).success).toBe(false);
  expect(SubledgerSourceInput.safeParse({ ...item, dueDate: "2026-02-30" }).success).toBe(false);
  expect(SubledgerSourceInput.safeParse({ ...item, postingDate: "1899-12-31" }).success).toBe(false);
  for (const reason of ["  ", "ab", "x".repeat(1001)])
    expect(SubledgerSourceInput.safeParse({ ...dates, kind: "allocation_reverse", reversalOf: id, reason }).success).toBe(false);
});
it("requires bounded cursor pages and exact inclusive watermarks", () => {
  expect(BalanceQuery.parse(query)).toEqual({ ...query, limit: 25 });
  expect(BalanceQuery.parse({ ...query, after: id, limit: 100 }).knownAt).toBe(query.knownAt);
  for (const limit of [0, 101, 1.5, "25"]) expect(BalanceQuery.safeParse({ ...query, limit }).success).toBe(false);
  for (const patch of [{ after: "guess" }, { offset: 1 }, { knownAt: "2026-12-31T23:59:59.123Z" }, { asOfDate: "2026-02-30" }])
    expect(BalanceQuery.safeParse({ ...query, ...patch }).success).toBe(false);
});
it("rejects numeric, negative or unsupported open-balance representations", () => {
  const row = { id, partyId: id, side: "ar", sourceId: id, journalId: id, postingDate: "2026-02-01", dueDate: "2026-02-28", originalAmount: "1.01", allocatedAmount: "0.01", outstandingAmount: "1.00" };
  expect(OpenBalance.parse(row)).toEqual(row);
  for (const outstandingAmount of [1, "-1.00", "1e3", "1", "1000000000000000000.00"])
    expect(OpenBalance.safeParse({ ...row, outstandingAmount }).success).toBe(false);
  expect(OpenBalance.safeParse({ ...row, paid: true }).success).toBe(false);
});
