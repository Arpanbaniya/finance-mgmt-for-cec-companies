import { DomainError } from "@/domain/errors";
import { PartyStatementCursor, StatementQuery } from "@/domain/party-statement";
import type { z } from "zod";

export function parseStatementQuery(entries: Iterable<[string, string]>) {
  const values: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (Object.hasOwn(values, key)) throw new DomainError("INVALID_STATEMENT_QUERY", "Statement query fields must occur once.", 400);
    values[key] = value;
  }
  if (typeof values.limit === "string" && /^[1-9]\d{0,2}$/.test(values.limit)) values.limit = Number(values.limit);
  return StatementQuery.parse(values);
}
export function encodeStatementCursor(value: z.infer<typeof PartyStatementCursor>) {
  return Buffer.from(JSON.stringify(PartyStatementCursor.parse(value)), "utf8").toString("base64url");
}
export function decodeStatementCursor(value: string, org: string, entity: string, party: string, query: z.infer<typeof StatementQuery>) {
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("Noncanonical encoding");
    const c = PartyStatementCursor.parse(JSON.parse(bytes.toString("utf8")));
    if (c.organizationId !== org || c.entityId !== entity || c.partyId !== party || c.fromDate !== query.fromDate
      || c.asOfDate !== query.asOfDate || (query.knownAt && c.knownAt !== query.knownAt)) throw new Error("Different report");
    return c;
  } catch { throw new DomainError("INVALID_CURSOR", "Use a cursor from the same party, entity, dates and knowledge cutoff.", 400); }
}
