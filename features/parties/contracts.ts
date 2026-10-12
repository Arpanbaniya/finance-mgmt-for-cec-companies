import { z } from "zod";
import { uuid } from "@/features/platform/contracts";
export { PartyCreate, PartyPatch } from "@/domain/parties";
export const PartyDTO = z.strictObject({
  id: uuid, organizationId: uuid, entityId: uuid, name: z.string(), roleSet: z.array(z.enum(["customer", "supplier"])).min(1).max(2),
  contact: z.string().nullable(), address: z.string().nullable(), taxIdentifier: z.string().nullable(), paymentTermsDays: z.number().int().nonnegative(),
  creditLimit: z.string().regex(/^(?:0|[1-9]\d{0,17})\.\d{2}$/).nullable(), active: z.boolean(), version: z.number().int().positive(),
  createdBy: z.string(), createdAt: z.iso.datetime(), updatedBy: z.string(), updatedAt: z.iso.datetime(),
  archivedBy: z.string().nullable(), archivedAt: z.iso.datetime().nullable(), archiveReason: z.string().nullable(),
});
