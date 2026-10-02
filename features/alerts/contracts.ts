import { z } from "zod";
import { uuid } from "@/features/platform/contracts";
export const Reason = z.strictObject({ reason: z.string().trim().min(3).max(1000) });
export const AlertDTO = z.strictObject({
  id: uuid, organizationId: uuid, entityId: uuid, kind: z.literal("approval_policy.activated"), policyId: uuid,
  createdAt: z.iso.datetime(), acknowledgedAt: z.iso.datetime().nullable(), version: z.number().int().min(1).max(2),
});
export const AlertCommandResult = z.strictObject({ resourceId: uuid, version: z.number().int().positive(), status: z.literal("acknowledged"), requestId: z.string() });
