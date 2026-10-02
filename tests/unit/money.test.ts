import { describe, expect, it } from "vitest";
import { decimal, money, allocate, Exact } from "@/domain/money";
describe("exact money", () => {
  it("rejects number JSON, exponents, excess precision, NaN and overflow", () => {
    for (const value of [1, "1e2", "NaN", "Infinity", "1.001", "1000000000000000000.00", "01.00"]) expect(() => decimal(value)).toThrow();
  });
  it("rounds half up without float drift", () => { expect(money(new Exact("1.005"))).toBe("1.01"); expect(money(new Exact("0.1").plus("0.2"))).toBe("0.30"); });
  it("allocates residual paise deterministically by stable ID", () => {
    expect(allocate("0.05", [{ id: "c", weight: "1" }, { id: "a", weight: "1" }, { id: "b", weight: "1" }])).toEqual([{ id: "c", amount: "0.01" }, { id: "a", amount: "0.02" }, { id: "b", amount: "0.02" }]);
  });
  it("conserves allocation totals across uneven bases", () => {
    for (let i = 1; i <= 100; i++) {
      const total = new Exact(i).div(100).toFixed(2);
      const values = allocate(total, [{ id: "a", weight: "1.3" }, { id: "b", weight: "2.7" }, { id: "c", weight: "0.9" }]);
      expect(values.reduce((sum, l) => sum.plus(l.amount), new Exact(0)).toFixed(2)).toBe(total);
    }
  });
  it("rejects zero denominator, negative weights and duplicate IDs", () => {
    expect(() => allocate("1.00", [{ id: "a", weight: "0" }])).toThrow();
    expect(() => allocate("1.00", [{ id: "a", weight: "-1" }])).toThrow();
    expect(() => allocate("1.00", [{ id: "a", weight: "1" }, { id: "a", weight: "1" }])).toThrow();
  });
});
