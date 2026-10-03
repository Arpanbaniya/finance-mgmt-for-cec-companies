import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { z } from "zod";
import { DomainError } from "@/domain/errors";
import { localDate } from "@/domain/dates";
import { AccountMappingsPatch, PeriodCreate, matchesPurpose, NumberRequest, CalendarDate, AccountPurposeSchema, type AccountPurpose } from "@/domain/finance-setup";
import { withScope } from "@/features/identity/scope";
import { audit } from "@/features/platform/service";
import { replay, remember } from "@/features/platform/idempotency";
import { contentHash } from "@/domain/approvals";
import { FiscalYearDTO, PeriodDTO, MappingRevisionDTO, AccountMappingsDTO } from "./setup-contracts";
function common(row: Record<string, unknown>) { return { id: row.id, organizationId: row.organization_id, entityId: row.legal_entity_id, version: row.version, createdBy: row.created_by, createdAt: (row.created_at as Date).toISOString() }; }
function periodDTO(row: Record<string, unknown>) { return PeriodDTO.parse({ ...common(row), fiscalYearId: row.fiscal_year_id, ordinal: row.ordinal, startDate: row.start_date, endDateExclusive: row.end_date_exclusive, state: row.state, closedAt: row.closed_at ? (row.closed_at as Date).toISOString() : null, closeSnapshotId: row.close_snapshot_id }); }
async function lockFinance(client: PoolClient, org: string, entity: string) {
  await client.query("SELECT app_security.lock_policy_scope($1,$2)", [org, entity]);
  const permission = await client.query("SELECT app_security.can_manage_accounts($1) AS allowed", [org]);
  if (!permission.rows[0].allowed) throw new DomainError("FORBIDDEN", "Current finance manager authority is required.", 403);
}
async function yearDTO(client: PoolClient, row: Record<string, unknown>) {
  const periods = await client.query("SELECT * FROM fiscal_periods WHERE organization_id=$1 AND legal_entity_id=$2 AND fiscal_year_id=$3 ORDER BY ordinal", [row.organization_id, row.legal_entity_id, row.id]);
  const series = await client.query("SELECT document_type,next_number::text FROM document_series WHERE organization_id=$1 AND legal_entity_id=$2 AND fiscal_year_id=$3 ORDER BY document_type", [row.organization_id, row.legal_entity_id, row.id]);
  return FiscalYearDTO.parse({ ...common(row), fiscalYearLabel: row.label, startDate: row.start_date, endDateExclusive: row.end_date_exclusive, retainedEarningsAccountId: row.retained_earnings_account_id, retainedEarningsAccountVersion: row.retained_earnings_account_version,
    periods: periods.rows.map(periodDTO), documentSeries: series.rows.map(s => ({ documentType: s.document_type, nextNumber: s.next_number })) });
}
export async function createFiscalYear(user: string, org: string, entity: string, input: z.infer<typeof PeriodCreate>, key: string, requestId: string) {
  const command = PeriodCreate.parse(input);
  return withScope(user, org, entity, "periods.create", async client => {
    await lockFinance(client, org, entity);
    const operation = `fiscal_year.create:${entity}`, hash = contentHash(command), prior = await replay(client, org, user, operation, key, hash);
    if (prior) return FiscalYearDTO.parse(prior);
    const retained = await client.query("SELECT * FROM accounts WHERE organization_id=$1 AND legal_entity_id=$2 AND id=$3", [org, entity, command.retainedEarningsAccountId]);
    if (!retained.rowCount) throw new DomainError("NOT_FOUND", "Retained earnings account is unavailable.", 404);
    if (!matchesPurpose("retained_earnings", { type: retained.rows[0].type, controlType: retained.rows[0].control_type, active: retained.rows[0].active })) throw new DomainError("INVALID_RETAINED_EARNINGS", "Choose an active ordinary equity account.");
    const start = command.periods[0].startDate, end = command.periods.at(-1)!.endDateExclusive;
    if ((await client.query("SELECT 1 FROM fiscal_years WHERE organization_id=$1 AND legal_entity_id=$2 AND (lower(btrim(label))=lower($3) OR (start_date<$5::date AND $4::date<end_date_exclusive))", [org, entity, command.fiscalYearLabel, start, end])).rowCount) throw new DomainError("FISCAL_YEAR_CONFLICT", "The label or calendar overlaps an existing fiscal year.", 409);
    const id = randomUUID(), inserted = await client.query("INSERT INTO fiscal_years(id,organization_id,legal_entity_id,label,start_date,end_date_exclusive,period_count,retained_earnings_account_id,retained_earnings_account_version,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *", [id, org, entity, command.fiscalYearLabel, start, end, command.periods.length, command.retainedEarningsAccountId, retained.rows[0].version, user]);
    for (const [index, period] of command.periods.entries()) await client.query("INSERT INTO fiscal_periods(id,organization_id,legal_entity_id,fiscal_year_id,ordinal,start_date,end_date_exclusive,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [randomUUID(), org, entity, id, index + 1, period.startDate, period.endDateExclusive, user]);
    const result = await yearDTO(client, inserted.rows[0]); await audit(client, org, user, "fiscal_year.create", id, requestId, entity); await remember(client, org, user, operation, key, hash, id, result); return result;
  });
}
export async function listFiscalYears(user: string, org: string, entity: string, limit: number, cursor?: string) {
  return withScope(user, org, entity, "periods.read", async client => {
    const rows = await client.query("SELECT * FROM fiscal_years WHERE organization_id=$1 AND legal_entity_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4", [org, entity, cursor ?? null, limit + 1]);
    // Bounded page; aggregate children in two queries rather than one query per year.
    const ids = rows.rows.slice(0, limit).map(row => row.id);
    const children = await client.query("SELECT * FROM fiscal_periods WHERE organization_id=$1 AND legal_entity_id=$2 AND fiscal_year_id=ANY($3::uuid[]) ORDER BY ordinal", [org, entity, ids]);
    const series = await client.query("SELECT fiscal_year_id,document_type,next_number::text FROM document_series WHERE organization_id=$1 AND legal_entity_id=$2 AND fiscal_year_id=ANY($3::uuid[]) ORDER BY document_type", [org, entity, ids]);
    const data = rows.rows.slice(0, limit).map(row => FiscalYearDTO.parse({ ...common(row), fiscalYearLabel: row.label, startDate: row.start_date, endDateExclusive: row.end_date_exclusive, retainedEarningsAccountId: row.retained_earnings_account_id, retainedEarningsAccountVersion: row.retained_earnings_account_version,
      periods: children.rows.filter(p => p.fiscal_year_id === row.id).map(periodDTO), documentSeries: series.rows.filter(s => s.fiscal_year_id === row.id).map(s => ({ documentType: s.document_type, nextNumber: s.next_number })) }));
    return { data, nextCursor: rows.rows.length > limit ? data.at(-1)!.id : null };
  });
}
export async function listPeriods(user: string, org: string, entity: string, limit: number, cursor?: string) {
  return withScope(user, org, entity, "periods.read", async client => {
    const rows = await client.query("SELECT * FROM fiscal_periods WHERE organization_id=$1 AND legal_entity_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4", [org, entity, cursor ?? null, limit + 1]);
    const data = rows.rows.slice(0, limit).map(periodDTO); return { data, nextCursor: rows.rows.length > limit ? data.at(-1)!.id : null };
  });
}
export async function getPeriod(user: string, org: string, entity: string, id: string) {
  return withScope(user, org, entity, "periods.read", async client => {
    const rows = await client.query("SELECT * FROM fiscal_periods WHERE organization_id=$1 AND legal_entity_id=$2 AND id=$3", [org, entity, id]);
    if (!rows.rowCount) throw new DomainError("NOT_FOUND", "Period is unavailable.", 404); return periodDTO(rows.rows[0]);
  });
}
async function revisionDTO(client: PoolClient, row: Record<string, unknown> | undefined) {
  if (!row) return null;
  const entries = await client.query("SELECT purpose,account_id,account_version FROM account_mapping_entries WHERE organization_id=$1 AND legal_entity_id=$2 AND revision_id=$3 ORDER BY purpose", [row.organization_id, row.legal_entity_id, row.id]);
  return MappingRevisionDTO.parse({ ...common(row), effectiveFrom: row.effective_from, reason: row.reason, mappings: entries.rows.map(e => ({ purpose: e.purpose, accountId: e.account_id, accountVersion: e.account_version })) });
}
async function mappingsDTO(client: PoolClient, org: string, entity: string) {
  const asOfDate = localDate(new Date());
  const rows = await client.query("SELECT * FROM account_mapping_revisions WHERE organization_id=$1 AND legal_entity_id=$2 AND (version=(SELECT max(version) FROM account_mapping_revisions WHERE organization_id=$1 AND legal_entity_id=$2) OR id=(SELECT id FROM account_mapping_revisions WHERE organization_id=$1 AND legal_entity_id=$2 AND effective_from<=$3::date ORDER BY effective_from DESC LIMIT 1)) ORDER BY version DESC", [org, entity, asOfDate]);
  const latest = await revisionDTO(client, rows.rows[0]), currentRow = rows.rows.find(r => r.effective_from <= asOfDate);
  const current = currentRow?.id === latest?.id ? latest : await revisionDTO(client, currentRow);
  return AccountMappingsDTO.parse({ organizationId: org, entityId: entity, version: latest?.version ?? 1, asOfDate, current, latest });
}
export async function getAccountMappings(user: string, org: string, entity: string) { return withScope(user, org, entity, "settings.read", async client => {
  if (!(await client.query("SELECT 1 FROM legal_entities WHERE organization_id=$1 AND id=$2", [org, entity])).rowCount) throw new DomainError("NOT_FOUND", "Company is unavailable.", 404);
  return mappingsDTO(client, org, entity);
}); }
export async function patchAccountMappings(user: string, org: string, entity: string, input: z.infer<typeof AccountMappingsPatch>, version: number, requestId: string) {
  const command = AccountMappingsPatch.parse(input);
  return withScope(user, org, entity, "settings.update", async client => {
    await lockFinance(client, org, entity); const old = await mappingsDTO(client, org, entity);
    if (old.version !== version) throw new DomainError("STALE_VERSION", "Reload the current account mappings before saving.", 412);
    if (old.latest && (command.effectiveFrom <= old.latest.effectiveFrom || command.effectiveFrom < old.asOfDate)) throw new DomainError("MAPPING_DATE_CONFLICT", "New mappings must start after the latest version and cannot take effect before today.", 409);
    const ids = [...new Set(command.mappings.map(item => item.accountId))];
    const rows = await client.query("SELECT * FROM accounts WHERE organization_id=$1 AND legal_entity_id=$2 AND id=ANY($3::uuid[])", [org, entity, ids]);
    const accounts = new Map(rows.rows.map(row => [row.id, row]));
    for (const entry of command.mappings) {
      const account = accounts.get(entry.accountId); if (!account) throw new DomainError("NOT_FOUND", "A mapped account is unavailable.", 404);
      if (!matchesPurpose(entry.purpose, { type: account.type, controlType: account.control_type, active: account.active })) throw new DomainError("INVALID_ACCOUNT_MAPPING", `Choose an active account with the required classification for ${entry.purpose.replaceAll("_", " ")}.`);
    }
    const id = randomUUID(); await client.query("INSERT INTO account_mapping_revisions(id,organization_id,legal_entity_id,version,effective_from,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)", [id, org, entity, version + 1, command.effectiveFrom, command.reason, user]);
    for (const entry of command.mappings) await client.query("INSERT INTO account_mapping_entries(organization_id,legal_entity_id,revision_id,purpose,account_id,account_version) VALUES($1,$2,$3,$4,$5,$6)", [org, entity, id, entry.purpose, entry.accountId, accounts.get(entry.accountId)!.version]);
    await audit(client, org, user, "account_mapping.create", id, requestId, entity); return mappingsDTO(client, org, entity);
  });
}
// Called within a posting transaction; never commits a separate number reservation.
export async function allocateDocumentNumber(client: PoolClient, org: string, entity: string, input: z.infer<typeof NumberRequest>) {
  const command = NumberRequest.parse(input);
  const row = (await client.query("SELECT * FROM app_security.allocate_document_number($1,$2,$3,$4,$5,$6)", [org, entity, command.documentType, command.sourceId, command.eventKind, command.postingDate])).rows[0];
  return { id: row.id as string, number: row.number as string, sequenceNumber: row.sequence_number as string, fiscalYearId: row.fiscal_year_id as string };
}
// Future source services freeze this revision and master version on submission.
export async function resolveAccountPurpose(client: PoolClient, org: string, entity: string, date: string, purpose: AccountPurpose) {
  CalendarDate.parse(date); AccountPurposeSchema.parse(purpose);
  const row = (await client.query("SELECT r.id AS revision_id,r.version AS mapping_version,e.account_id,e.account_version FROM account_mapping_revisions r JOIN account_mapping_entries e ON e.revision_id=r.id AND e.organization_id=r.organization_id AND e.legal_entity_id=r.legal_entity_id WHERE r.organization_id=$1 AND r.legal_entity_id=$2 AND r.effective_from<=$3::date AND e.purpose=$4 ORDER BY r.effective_from DESC LIMIT 1", [org, entity, date, purpose])).rows[0];
  if (!row) throw new DomainError("ACCOUNT_MAPPING_REQUIRED", "Configure the account purpose before posting.");
  return { revisionId: row.revision_id as string, mappingVersion: row.mapping_version as number, accountId: row.account_id as string, accountVersion: row.account_version as number };
}
