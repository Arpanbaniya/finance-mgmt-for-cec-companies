import { expect, it } from "vitest";
import { prepareManualPosting } from "@/domain/posting";
const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222";
const input = () => ({ postingDate: "2026-10-03", documentDate: "2026-10-01", description: "  Reviewed adjustment  ", currency: "NPR", lines: [
  { accountId: a, accountVersion: 1, debit: "1", credit: "0" },
  { accountId: b, accountVersion: 2, debit: "0", credit: "1.0" },
] });
it("normalizes posting decimal strings without introducing numeric boundaries", () => {
  const prepared = prepareManualPosting(input());
  expect(prepared.totals).toEqual({ debit: "1.00", credit: "1.00" });
  expect(prepared.posting.description).toBe("Reviewed adjustment");
  expect(prepared.posting.lines[0]).toMatchObject({ debit: "1.00", credit: "0.00", dimensions: {} });
});
it.each([1, "NaN", "Infinity", "1e0", "0.001", "-1", "1000000000000000000", "01"])("rejects invalid money %s before posting", amount => {
  const value = input(); expect(() => prepareManualPosting({ ...value, lines: [{ ...value.lines[0], debit: amount }, value.lines[1]] })).toThrow();
});
it("rejects caller-supplied source identity, approval flags and unsupported dimensions", () => {
  expect(() => prepareManualPosting({ ...input(), approved: true })).toThrow();
  expect(() => prepareManualPosting({ ...input(), sourceType: "invoice" })).toThrow();
  const value = input();
  expect(() => prepareManualPosting({ ...value, lines: [{ ...value.lines[0], dimensions: { workerId: a } }, value.lines[1]] })).toThrow();
});
it("requires valid dates, UUID master references, integer versions and NPR", () => {
  for (const patch of [{ postingDate: "2026-02-30" }, { documentDate: "1899-01-01" }, { currency: "USD" }]) expect(() => prepareManualPosting({ ...input(), ...patch })).toThrow();
  const value = input();
  for (const patch of [{ accountId: "guessed" }, { accountVersion: 0 }, { accountVersion: 1.5 }, { accountVersion: 2147483648 }]) expect(() => prepareManualPosting({ ...value, lines: [{ ...value.lines[0], ...patch }, value.lines[1]] })).toThrow();
});
it("enforces exact balance, one-sided lines and bounded total money", () => {
  const value = input();
  expect(() => prepareManualPosting({ ...value, lines: [value.lines[0], { ...value.lines[1], credit: "0.99" }] })).toThrow(/exactly/);
  expect(() => prepareManualPosting({ ...value, lines: [{ ...value.lines[0], credit: "1" }, value.lines[1]] })).toThrow();
  const maximum = "999999999999999999.99";
  expect(prepareManualPosting({ ...value, lines: [{ ...value.lines[0], debit: maximum }, { ...value.lines[1], credit: maximum }] }).totals.debit).toBe(maximum);
  expect(() => prepareManualPosting({ ...value, lines: [{ ...value.lines[0], debit: maximum }, { ...value.lines[1], credit: maximum }, ...value.lines] })).toThrow(/supported range/);
});
