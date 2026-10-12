import { z } from "zod";
import { PolicyDraft, taxEvaluatorVersion } from "@/domain/tax-rules";
export { PolicyDraft };
export const PolicyDraftDTO = PolicyDraft.safeExtend({ id: z.uuid(), organizationId: z.uuid(), entityId: z.uuid(),
  jurisdiction: z.literal("NP"), currency: z.literal("NPR"), evaluatorVersion: z.literal(taxEvaluatorVersion),
  status: z.literal("draft"), version: z.literal(1), contentHash: z.string().regex(/^[a-f0-9]{64}$/), createdBy: z.string(), createdAt: z.iso.datetime() });
