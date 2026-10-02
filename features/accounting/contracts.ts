import { z } from "zod";
import { AccountFields } from "@/domain/accounts";
export { AccountCreate, AccountPatch } from "@/domain/accounts";
export const AccountDTO = z.strictObject({ ...AccountFields.shape, code: z.string().min(1).max(100).regex(/^[A-Z0-9][A-Z0-9._-]*$/), id: z.uuid(), organizationId: z.uuid(), entityId: z.uuid(), active: z.boolean(), version: z.number().int().positive(),
  createdBy: z.string(), createdAt: z.iso.datetime(), updatedBy: z.string(), updatedAt: z.iso.datetime(), archivedBy: z.string().nullable(), archivedAt: z.iso.datetime().nullable(), archiveReason: z.string().nullable() });
