import { expect, it } from "vitest";
import { validateJournal, reverseLines } from "@/domain/accounting";
const fixture = [
  { accountId: "bank", debit: "98500.00", credit: "0.00" },
  { accountId: "ar", debit: "15300.00", credit: "0.00" },
  { accountId: "withholding", debit: "1000.00", credit: "0.00" },
  { accountId: "wages", debit: "22000.00", credit: "0.00" },
  { accountId: "employer-contribution", debit: "700.00", credit: "0.00" },
  { accountId: "capital", debit: "0.00", credit: "100000.00" },
  { accountId: "revenue", debit: "0.00", credit: "33000.00" },
  { accountId: "output-tax", debit: "0.00", credit: "3300.00" },
  { accountId: "statutory", debit: "0.00", credit: "1200.00" }
];
it("independently verifies specification fixture A", () => { expect(validateJournal(fixture)).toEqual({ debit: "137500.00", credit: "137500.00" }); });
it("rejects imbalance of one paisa", () => { expect(() => validateJournal([{ accountId: "a", debit: "1.00", credit: "0.00" }, { accountId: "b", debit: "0.00", credit: "0.99" }])).toThrow("exactly"); });
it("rejects zero, negative or two-sided journal lines", () => {
  for (const line of [{ debit: "0.00", credit: "0.00" }, { debit: "1.00", credit: "1.00" }, { debit: "-1.00", credit: "0.00" }]) expect(() => validateJournal([{ accountId: "a", ...line }, fixture[0]])).toThrow();
});
it("reversal preserves balance and two reversals restore original", () => { expect(validateJournal(reverseLines(fixture))).toEqual({ debit: "137500.00", credit: "137500.00" }); expect(reverseLines(reverseLines(fixture))).toEqual(fixture); });
