import Decimal from "decimal.js";
import { DomainError } from "./errors";

export const Exact = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });
const maximum = new Exact("999999999999999999.99");

export function decimal(value: unknown, scale = 2): Decimal {
  if (typeof value !== "string" || !new RegExp(`^-?(?:0|[1-9]\\d*)(?:\\.\\d{1,${scale}})?$`).test(value)) {
    throw new DomainError("INVALID_DECIMAL", `Use a decimal string with at most ${scale} decimal places.`);
  }
  const amount = new Exact(value);
  if (amount.abs().greaterThan(maximum)) throw new DomainError("MONEY_OVERFLOW", "Amount exceeds the supported range.");
  return amount;
}

export function money(value: string | Decimal): string {
  const rounded = new Exact(value).toDecimalPlaces(2);
  if (!rounded.isFinite() || rounded.abs().greaterThan(maximum)) throw new DomainError("MONEY_OVERFLOW", "Amount exceeds the supported range.");
  return rounded.toFixed(2);
}

export function allocate(total: string, weightedLines: { id: string; weight: string }[]): { id: string; amount: string }[] {
  const amount = decimal(total);
  if (amount.isNegative() || !weightedLines.length || new Set(weightedLines.map(l => l.id)).size !== weightedLines.length) {
    throw new DomainError("INVALID_ALLOCATION", "Use nonnegative total and distinct nonempty line IDs.");
  }
  const weights = weightedLines.map(l => ({ ...l, exact: decimal(l.weight, 8) }));
  if (weights.some(l => l.exact.isNegative())) throw new DomainError("INVALID_ALLOCATION", "Weights cannot be negative.");
  const sum = weights.reduce((s, l) => s.plus(l.exact), new Exact(0));
  if (sum.isZero()) throw new DomainError("ZERO_BASIS", "Allocation needs a positive basis.");
  const paise = amount.times(100);
  const parts = weights.map(l => { const share = paise.times(l.exact).div(sum); return { id: l.id, units: share.floor(), fraction: share.minus(share.floor()) }; });
  const remainder = paise.minus(parts.reduce((s, l) => s.plus(l.units), new Exact(0))).toNumber();
  const ordered = [...parts].sort((a, b) => b.fraction.comparedTo(a.fraction) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = 0; i < remainder; i++) ordered[i].units = ordered[i].units.plus(1);
  return parts.map(l => ({ id: l.id, amount: l.units.div(100).toFixed(2) }));
}
