import { z } from "zod";
import { roleGrants } from "@/domain/permissions";

export const uuid = z.uuid();
export const EntityCreate = z.strictObject({
  name: z.string().trim().min(1).max(200), registrationIdentifier: z.string().max(100).optional(), taxIdentifier: z.string().max(100).optional(),
  baseCurrency: z.literal("NPR"), timezone: z.literal("Asia/Kathmandu"), activeModes: z.array(z.literal("labour")).min(1).max(1), reportingProfile: z.enum(["demo_accrual", "review_required"])
});
export const EntityPatch = z.strictObject({
  name: EntityCreate.shape.name.optional(), registrationIdentifier: z.string().trim().max(100).nullable().optional(),
  taxIdentifier: z.string().trim().max(100).nullable().optional(), activeModes: EntityCreate.shape.activeModes.optional(),
}).refine(v => Object.keys(v).length > 0, "Supply at least one editable field.");
export const MembershipChange = z.strictObject({
  userId: z.string().min(1).max(200), allowedEntityIds: z.array(uuid).max(500),
  roleIds: z.array(z.enum(Object.keys(roleGrants) as [keyof typeof roleGrants, ...(keyof typeof roleGrants)[]])).min(1).max(7),
  siteIds: z.array(uuid).max(500).length(0, "Site grants require the later workforce module."), active: z.boolean()
});
export const ListQuery = z.strictObject({ cursor: uuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(25) });
export const EntityDTO = z.strictObject({
  id: uuid, organizationId: uuid, name: z.string(), registrationIdentifier: z.string().nullable(), taxIdentifier: z.string().nullable(),
  baseCurrency: z.literal("NPR"), timezone: z.literal("Asia/Kathmandu"), activeModes: z.array(z.literal("labour")), reportingProfile: z.enum(["demo_accrual", "review_required"]),
  policyStatus: z.enum(["demo", "review_required"]), version: z.number().int(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime()
});
export const MembershipDTO = z.strictObject({ id: uuid, organizationId: uuid, userId: z.string(), roleIds: z.array(z.string()), allowedEntityIds: z.array(uuid), siteIds: z.array(uuid), active: z.boolean(), version: z.number().int() });
export const HealthDTO = z.strictObject({ status: z.literal("ok"), release: z.literal("R1"), version: z.string() });
export type EntityInput = z.infer<typeof EntityCreate>;
