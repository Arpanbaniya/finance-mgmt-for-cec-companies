import { expect, it } from "vitest";
import { ReportQuery, ReportResult, ReportType } from "@/features/reporting/report-contracts";
import { parseReportQuery } from "@/features/reporting/report-query";
import { openapi } from "@/features/platform/openapi";
const interval = { fromDate: "2026-01-01", toDateExclusive: "2027-01-01" };
it("requires report-specific date/account fields and bounded exact pagination", () => {
  for (const type of ["trial-balance", "profit-loss"]) expect(ReportQuery.safeParse({ reportType: type, ...interval }).success).toBe(true);
  expect(ReportQuery.safeParse({ reportType: "balance-sheet", asOfDate: "2026-12-31" }).success).toBe(true);
  expect(ReportQuery.safeParse({ reportType: "general-ledger", ...interval, accountId: "00000000-0000-4000-8000-000000000001", limit: 100 }).success).toBe(true);
  for (const query of [{ reportType: "profit-loss" }, { reportType: "balance-sheet", ...interval }, { reportType: "general-ledger", ...interval }, { reportType: "profit-loss", ...interval, limit: 1 }, { reportType: "trial-balance", ...interval, limit: 101 }, { reportType: "trial-balance", ...interval, limit: "25" }, { reportType: "balance-sheet", asOfDate: "9999-12-31" }, { reportType: "profit-loss", ...interval, dimensions: {} }, { reportType: "profit-loss", ...interval, view: "finance" }]) expect(ReportQuery.safeParse(query).success).toBe(false);
});
it("rejects repeated fields, path-type overrides and ambiguous URL coercion", () => {
  const valid = parseReportQuery("trial-balance", new URLSearchParams({ ...interval, limit: "100", includeComparative: "false" }));
  expect(valid.limit).toBe(100); expect(valid.includeComparative).toBe(false);
  for (const limit of ["0", "01", "1e2", "1.0", " 25", "101"]) expect(() => parseReportQuery("trial-balance", new URLSearchParams({ ...interval, limit }))).toThrow();
  expect(() => parseReportQuery("trial-balance", new URLSearchParams(`fromDate=2026-01-01&fromDate=2026-02-01&toDateExclusive=2027-01-01`))).toThrow("occur once");
  expect(() => parseReportQuery("profit-loss", new URLSearchParams({ ...interval, reportType: "trial-balance" }))).toThrow("path");
  expect(ReportType.safeParse("unknown-table").success).toBe(false);
});
it("documents a finite string report path, query conditions and four concrete response variants", () => {
  const doc = openapi(), path = "/api/v1/orgs/{orgId}/entities/{entityId}/reports/{reportType}";
  const operation = doc.paths[path].get as { parameters: { name: string; in: string; schema: { format?: string; enum?: string[] } }[]; "x-permission": string; "x-report-query-schema": { $ref: string } };
  const type = operation.parameters.find(item => item.name === "reportType")!;
  expect(type.schema.enum).toContain("general-ledger"); expect(type.schema.format).toBeUndefined(); expect(type.in).toBe("path");
  expect(operation.parameters.filter(item => item.in === "query").map(item => item.name)).toEqual(expect.arrayContaining(["fromDate", "toDateExclusive", "asOfDate", "knownAt", "accountId", "cursor", "limit", "includeComparative"]));
  expect(operation["x-permission"]).toBe("reports.read"); expect(operation["x-report-query-schema"].$ref).toBe("#/components/schemas/ReportQuery");
  expect((doc.components.schemas.ReportQuery as { allOf: unknown[] }).allOf).toHaveLength(4);
  const response = doc.components.schemas.ReportResult as { properties: { data: { oneOf?: unknown[]; anyOf?: unknown[] } } };
  expect(response.properties.data.oneOf ?? response.properties.data.anyOf).toHaveLength(4);
  expect(ReportResult.safeParse({ reportType: "cash-flow", totals: {} }).success).toBe(false);
});
