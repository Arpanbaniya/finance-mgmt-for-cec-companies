import { z } from "zod";
import { StatementQuery, PartyStatementActivity, PartyStatementComponent, PartyAgeing } from "@/domain/party-statement";
import { ReportInstant } from "@/domain/statements";
export { StatementQuery };
export const PartyStatement = z.strictObject({
  metadata: z.strictObject({ organizationId: z.uuid(), entityId: z.uuid(), partyId: z.uuid(), currency: z.literal("NPR"),
    fromDate: z.iso.date(), asOfDate: z.iso.date(), knownAt: ReportInstant, generatedAt: ReportInstant,
    ledgerWatermark: ReportInstant.nullable(), sourceCount: z.string().regex(/^\d+$/),
    reportVersion: z.literal("party-statement-v1"), mappingBasis: z.literal("posted-account-versions"),
    balanceConvention: z.literal("separate-normal-positive-books"),
  }),
  party: z.strictObject({ id: z.uuid(), name: z.string().min(1).max(200), version: z.number().int().positive(),
    active: z.boolean(), nameBasis: z.literal("retained-master-at-knowledge-cutoff") }),
  balances: z.array(PartyStatementComponent).length(4), ageing: z.array(PartyAgeing).length(2),
  activity: z.array(PartyStatementActivity).max(100), nextCursor: z.string().max(2048).nullable(),
  limitations: z.array(z.string()),
});
