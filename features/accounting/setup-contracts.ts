import { z } from "zod";
import { CalendarDate, AccountPurposeSchema, DocumentType } from "@/domain/finance-setup";
export { PeriodCreate, AccountMappingsPatch } from "@/domain/finance-setup";
const scope = { id: z.uuid(), organizationId: z.uuid(), entityId: z.uuid(), version: z.number().int().positive(), createdBy: z.string(), createdAt: z.iso.datetime() };
export const PeriodDTO = z.strictObject({ ...scope, fiscalYearId: z.uuid(), ordinal: z.number().int().positive(), startDate: CalendarDate, endDateExclusive: CalendarDate, state: z.enum(["open", "soft_closed", "hard_closed"]), closedAt: z.iso.datetime().nullable(), closeSnapshotId: z.uuid().nullable() });
export const FiscalYearDTO = z.strictObject({ ...scope, fiscalYearLabel: z.string(), startDate: CalendarDate, endDateExclusive: CalendarDate, retainedEarningsAccountId: z.uuid(), retainedEarningsAccountVersion: z.number().int().positive(), periods: z.array(PeriodDTO).min(1).max(24), documentSeries: z.array(z.strictObject({ documentType: DocumentType, nextNumber: z.string().regex(/^[1-9][0-9]*$/) })) });
export const MappingRevisionDTO = z.strictObject({ ...scope, effectiveFrom: CalendarDate, reason: z.string(), mappings: z.array(z.strictObject({ purpose: AccountPurposeSchema, accountId: z.uuid(), accountVersion: z.number().int().positive() })) });
export const AccountMappingsDTO = z.strictObject({ organizationId: z.uuid(), entityId: z.uuid(), version: z.number().int().positive(), asOfDate: CalendarDate, current: MappingRevisionDTO.nullable(), latest: MappingRevisionDTO.nullable() });
