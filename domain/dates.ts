import { DomainError } from "./errors";

export const BUSINESS_TIMEZONE = "Asia/Kathmandu";
export function businessDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new DomainError("INVALID_DATE", "Use an ISO business date.");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || value < "1900-01-01" || value > "9999-12-31") throw new DomainError("INVALID_DATE", "Date is outside the supported calendar.");
  return value;
}
export function containsDate(from: string, toExclusive: string | null, candidate: string): boolean {
  businessDate(from); businessDate(candidate); if (toExclusive) businessDate(toExclusive);
  return candidate >= from && (!toExclusive || candidate < toExclusive);
}
export function localDate(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}
