import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PeriodCreate, AccountMappingsPatch, purposeRules, matchesPurpose, NumberRequest } from "@/domain/finance-setup";
import { openapi } from "@/features/platform/openapi";
const calendar = { fiscalYearLabel: "Actual dates", retainedEarningsAccountId: randomUUID(), periods: [{ startDate: "2026-07-17", endDateExclusive: "2026-08-17" }, { startDate: "2026-08-17", endDateExclusive: "2027-07-17" }] };
it("validates actual contiguous dates without inferring a fixed Nepal fiscal boundary", () => {
  expect(PeriodCreate.parse(calendar)).toEqual(calendar);
  for (const input of [{ ...calendar, periods: [] }, { ...calendar, periods: [{ startDate: "2026-02-29", endDateExclusive: "2026-03-01" }] }, { ...calendar, periods: [{ startDate: "2026-07-17", endDateExclusive: "2026-07-17" }] }, { ...calendar, periods: [...calendar.periods].reverse() }, { ...calendar, periods: [calendar.periods[0], { ...calendar.periods[1], startDate: "2026-08-18" }] }, { ...calendar, state: "hard_closed" }, { ...calendar, createdBy: "other" }]) expect(PeriodCreate.safeParse(input).success).toBe(false);
});
it("requires a complete finite mapping and no duplicate or arbitrary purpose", () => {
  const mappings = Object.keys(purposeRules).map(purpose => ({ purpose, accountId: randomUUID() })), valid = { effectiveFrom: "2026-01-01", reason: "Initial reviewed setup", mappings };
  expect(AccountMappingsPatch.parse(valid)).toEqual(valid);
  for (const input of [{ ...valid, mappings: mappings.slice(1) }, { ...valid, mappings: mappings.map(() => mappings[0]) }, { ...valid, mappings: [{ ...mappings[0], purpose: "arbitrary" }, ...mappings.slice(1)] }, { ...valid, mappings: mappings.map(m => ({ ...m, accountVersion: 999 })) }, { ...valid, version: 5 }]) expect(AccountMappingsPatch.safeParse(input).success).toBe(false);
  expect(matchesPurpose("ar", { type: "asset", controlType: "ar", active: true })).toBe(true);
  expect(matchesPurpose("ar", { type: "asset", controlType: null, active: true })).toBe(false);
  expect(matchesPurpose("ar", { type: "asset", controlType: "ar", active: false })).toBe(false);
});
it("numbering accepts only the internal source-bound request vocabulary", () => {
  expect(NumberRequest.safeParse({ documentType: "journal", sourceId: randomUUID(), eventKind: "post", postingDate: "2026-07-17" }).success).toBe(true);
  expect(NumberRequest.safeParse({ documentType: "stock_issue", sourceId: randomUUID(), eventKind: "post", postingDate: "2026-07-17" }).success).toBe(false);
});
it("six setup operations expose concrete schemas and conditional mapping edits", () => {
  const doc = openapi(), base = "/api/v1/orgs/{orgId}/entities/{entityId}";
  for (const name of ["FiscalYear", "FiscalYearList", "Period", "PeriodList", "AccountMappings", "PeriodCreate", "AccountMappingsPatch"]) expect(doc.components.schemas[name]).toBeDefined();
  expect(doc.paths[`${base}/account-mappings`].patch).toMatchObject({ parameters: expect.arrayContaining([expect.objectContaining({ name: "If-Match", required: true })]) });
  expect(Object.keys(doc.paths).some(path => path.includes("document-series"))).toBe(false);
});
