import { z } from "zod";
import { ManualPosting } from "@/domain/posting";
export { JournalCreate, JournalPatch } from "@/domain/manual-journal";
const MoneyDTO = z.string().regex(/^(0|[1-9][0-9]{0,17})\.[0-9]{2}$/);
const LineDTO = z.strictObject({ accountId: z.uuid(), accountVersion: z.number().int().positive(), debit: MoneyDTO, credit: MoneyDTO, dimensions: z.strictObject({ branchId: z.uuid().optional() }) });
export const JournalDTO = z.strictObject({
  ...ManualPosting.shape, lines: z.array(LineDTO).min(2).max(500), id: z.uuid(), organizationId: z.uuid(), entityId: z.uuid(),
  sourceType: z.literal("journal"), sourceId: z.uuid(), eventKind: z.literal("manual"),
  status: z.enum(["draft", "cancelled"]), version: z.number().int().positive(),
  debit: MoneyDTO, credit: MoneyDTO, createdBy: z.string(), updatedBy: z.string(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), cancelReason: z.string().nullable(),
});
export const JournalCancelResult = z.strictObject({ resourceId: z.uuid(), version: z.number().int().positive(), status: z.literal("cancelled"), requestId: z.string() });
