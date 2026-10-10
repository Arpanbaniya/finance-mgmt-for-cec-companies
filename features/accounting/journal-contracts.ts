import { z } from "zod";
import { ManualPosting } from "@/domain/posting";
import { CalendarDate } from "@/domain/finance-setup";
export { JournalCreate, JournalPatch } from "@/domain/manual-journal";
const MoneyDTO = z.string().regex(/^(0|[1-9][0-9]{0,17})\.[0-9]{2}$/);
const LineDTO = z.strictObject({ accountId: z.uuid(), accountVersion: z.number().int().positive(), debit: MoneyDTO, credit: MoneyDTO, dimensions: z.strictObject({ branchId: z.uuid().optional() }) });
export const JournalDTO = z.strictObject({
  ...ManualPosting.shape, lines: z.array(LineDTO).min(2).max(500), id: z.uuid(), organizationId: z.uuid(), entityId: z.uuid(),
  sourceType: z.literal("journal"), sourceId: z.uuid(), eventKind: z.enum(["manual", "reverse"]),
  status: z.enum(["draft", "submitted", "approved", "posted", "reversed", "cancelled"]), version: z.number().int().positive(),
  debit: MoneyDTO, credit: MoneyDTO, createdBy: z.string(), updatedBy: z.string(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), cancelReason: z.string().nullable(),
  journalId: z.uuid().nullable().default(null), number: z.string().nullable().default(null), transitionReason: z.string().nullable().default(null),
  reversalOf: z.uuid().nullable().default(null), reversalOfSourceId: z.uuid().nullable().default(null),
  reversalRequestId: z.uuid().nullable().default(null), reversalJournalId: z.uuid().nullable().default(null),
  review: z.strictObject({ sourceVersion: z.number().int().positive(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), policyId: z.uuid(), policyVersion: z.number().int().positive(),
    requiredApprovals: z.number().int().positive(), validApprovals: z.number().int().nonnegative(), snapshotValid: z.boolean(), canApprove: z.boolean(),
    approvals: z.array(z.strictObject({ actorId: z.string(), reason: z.string(), createdAt: z.iso.datetime(), eligible: z.boolean() })) }).nullable().default(null),
});
export const JournalCancelResult = z.strictObject({ resourceId: z.uuid(), version: z.number().int().positive(), status: z.literal("cancelled"), requestId: z.string() });
export const JournalCommandResult = z.strictObject({ resourceId: z.uuid(), version: z.number().int().positive(), status: z.enum(["draft", "submitted", "approved", "posted"]), journalId: z.uuid().optional(), requestId: z.string() });
export const JournalNoBody = z.strictObject({});
export const DateAction = z.strictObject({ postingDate: CalendarDate, reason: z.string().trim().min(3).max(1000) });
