import { z } from "zod";
import { ApprovalPolicyFields } from "@/domain/approval-policy";
import { uuid, ListQuery } from "@/features/platform/contracts";
export { ApprovalPolicyCreate } from "@/domain/approval-policy";
export const Transition = z.strictObject({ reason: z.string().trim().min(3).max(1000).optional() });
export const ApprovalPolicyDTO = z.strictObject({
  ...ApprovalPolicyFields.shape, id: uuid, organizationId: uuid, entityId: uuid, status: z.enum(["draft", "active"]),
  version: z.number().int().positive(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), createdBy: z.string(),
  createdAt: z.iso.datetime(), activatedBy: z.string().nullable(), activatedAt: z.iso.datetime().nullable(), activationReason: z.string().nullable(),
  deliveryJobId: uuid.nullable().default(null),
});
export const CommandResult = z.strictObject({ resourceId: uuid, version: z.number().int().positive(), status: z.literal("active"), requestId: z.string() });
export const AuditQuery = ListQuery.extend({
  action: z.string().regex(/^[a-z_]+\.[a-z_]+$/).max(100).optional(), targetType: z.enum(["entity", "approval_policy", "alert", "job", "account"]).optional(),
  targetId: uuid.optional(), actorId: z.string().min(1).max(200).optional(), fromInstant: z.iso.datetime().optional(), toInstantExclusive: z.iso.datetime().optional(),
}).refine(value => !value.fromInstant || !value.toInstantExclusive || value.fromInstant < value.toInstantExclusive, "End instant must follow start.");
export const AuditEventDTO = z.strictObject({ id: uuid, organizationId: uuid, entityId: uuid, actorId: z.string(), action: z.string(), targetType: z.string(), targetId: uuid, requestId: z.string(), occurredAt: z.iso.datetime() });
