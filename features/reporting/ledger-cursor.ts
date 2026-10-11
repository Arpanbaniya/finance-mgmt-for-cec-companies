import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { bindLedgerCursor, LedgerCursor, LedgerQuery, type LedgerCursorValue } from "@/domain/general-ledger";

export function encodeLedgerCursor(value: LedgerCursorValue) {
  return Buffer.from(JSON.stringify(LedgerCursor.parse(value)), "utf8").toString("base64url");
}
export function decodeLedgerCursor(value: string, organizationId: string, entityId: string, query: z.infer<typeof LedgerQuery>) {
  try {
    if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) throw new Error("Invalid encoding");
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("Noncanonical encoding");
    return bindLedgerCursor(JSON.parse(bytes.toString("utf8")), organizationId, entityId, query);
  } catch {
    throw new DomainError("INVALID_CURSOR", "Use a valid cursor from the same entity, account, dates and knowledge cutoff.", 400);
  }
}
