import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { CalendarDate } from "@/domain/finance-setup";
import { ReportInstant } from "@/domain/statements";
import type { ReportQueryValue } from "./report-contracts";
export const TrialCursor = z.strictObject({ kind: z.literal("trial-balance-v1"), organizationId: z.uuid(), entityId: z.uuid(), fromDate: CalendarDate,
  toDateExclusive: CalendarDate, knownAt: ReportInstant, accountId: z.uuid() });
export function encodeTrialCursor(value: z.infer<typeof TrialCursor>) { return Buffer.from(JSON.stringify(TrialCursor.parse(value))).toString("base64url"); }
export function decodeTrialCursor(value: string, organizationId: string, entityId: string, query: ReportQueryValue) {
  try {
    if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) throw Error();
    const bytes = Buffer.from(value, "base64url"); if (bytes.toString("base64url") !== value) throw Error();
    const cursor = TrialCursor.parse(JSON.parse(bytes.toString("utf8")));
    if (cursor.organizationId !== organizationId || cursor.entityId !== entityId || cursor.fromDate !== query.fromDate || cursor.toDateExclusive !== query.toDateExclusive || (query.knownAt && cursor.knownAt !== query.knownAt)) throw Error();
    return cursor;
  } catch { throw new DomainError("INVALID_CURSOR", "Use a trial-balance cursor from the same entity, dates and knowledge cutoff.", 400); }
}
