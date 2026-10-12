import { DomainError } from "@/domain/errors";
import { ReportQuery } from "./report-contracts";

/** Shared HTTP/page adapter: reject repeated keys instead of silently choosing one. */
export function parseReportQuery(reportType: string, entries: Iterable<[string, string]>) {
  const values: Record<string, unknown> = { reportType };
  for (const [key, value] of entries) {
    if (Object.hasOwn(values, key)) throw new DomainError("INVALID_REPORT_QUERY", "Report query fields must occur once; report type belongs in the path.", 400);
    values[key] = value;
  }
  if (values.limit !== undefined && typeof values.limit === "string" && /^[1-9]\d{0,2}$/.test(values.limit)) values.limit = Number(values.limit);
  if (values.includeComparative === "false") values.includeComparative = false;
  if (values.includeComparative === "true") values.includeComparative = true;
  return ReportQuery.parse(values);
}
