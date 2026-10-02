import { z } from "zod";
export { Reason } from "@/features/alerts/contracts";
export const JobDTO = z.strictObject({
  id: z.uuid(), organizationId: z.uuid(), entityId: z.uuid(), version: z.number().int().positive(),
  type: z.literal("approval_policy.activated"), schemaVersion: z.literal(1),
  sourceId: z.uuid(), sourceVersion: z.literal(2), inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["pending", "leased", "delivered", "cancelled", "failed"]),
  attempts: z.number().int().min(0).max(3), totalAttempts: z.number().int().min(0).max(12),
  retryCount: z.number().int().min(0).max(3), maxRetries: z.literal(3),
  totalItems: z.literal(1), completedItems: z.number().int().min(0).max(1),
  availableAt: z.iso.datetime(), leaseExpiresAt: z.iso.datetime().nullable(),
  errorCode: z.enum(["DELIVERY_FAILED", "RECIPIENT_UNAVAILABLE", "SOURCE_CHANGED", "ATTEMPTS_EXHAUSTED"]).nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(),
  retryHistory: z.array(z.strictObject({ fromVersion: z.number().int().positive(), reason: z.string(), requestId: z.string(), createdAt: z.iso.datetime() })).max(3),
});
export const JobResult = z.strictObject({ jobId: z.uuid(), status: z.literal("pending"), statusUrl: z.string(), version: z.number().int().positive() });
