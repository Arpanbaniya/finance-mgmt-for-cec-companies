import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { z } from "zod";
import { DomainError } from "@/domain/errors";
import { contentHash } from "@/domain/approvals";
import { withScope } from "@/features/identity/scope";
import { audit } from "@/features/platform/service";
import { replay, remember } from "@/features/platform/idempotency";
import { Reason } from "@/features/alerts/contracts";
import { AccountCreate, AccountPatch, AccountDTO } from "./contracts";
import { isParentCandidate } from "@/domain/accounts";

function dto(row: Record<string, unknown>) {
  return AccountDTO.parse({ id: row.id, organizationId: row.organization_id, entityId: row.legal_entity_id, code: row.code, name: row.name,
    type: row.type, normalSide: row.normal_side, parentId: row.parent_id, isControl: row.is_control, controlType: row.control_type,
    reportMapping: { statementSection: row.report_section, cashFlowCategory: row.cash_flow_category }, active: row.active, version: row.version,
    createdBy: row.created_by, createdAt: (row.created_at as Date).toISOString(), updatedBy: row.updated_by, updatedAt: (row.updated_at as Date).toISOString(),
    archivedBy: row.archived_by, archivedAt: row.archived_at ? (row.archived_at as Date).toISOString() : null, archiveReason: row.archive_reason });
}
async function authorizeWrite(client: PoolClient, org: string, entity: string) {
  await client.query("SELECT app_security.lock_policy_scope($1,$2)", [org, entity]);
  const allowed = await client.query("SELECT app_security.can_manage_accounts($1) AND app_security.can_entity($1,$2) AS allowed", [org, entity]);
  if (!allowed.rows[0].allowed) throw new DomainError("FORBIDDEN", "Current finance manager authority is required.", 403);
}
async function selected(client: PoolClient, org: string, entity: string, id: string, lock = false) {
  const rows = await client.query(`SELECT * FROM accounts WHERE organization_id=$1 AND legal_entity_id=$2 AND id=$3${lock ? " FOR UPDATE" : ""}`, [org, entity, id]);
  if (!rows.rowCount) throw new DomainError("NOT_FOUND", "Account is unavailable.", 404);
  return rows.rows[0];
}
async function validateParent(client: PoolClient, org: string, entity: string, account: z.infer<typeof AccountDTO> | z.infer<typeof AccountCreate>, id?: string) {
  if (!account.parentId) return;
  const parent = await selected(client, org, entity, account.parentId);
  if (!isParentCandidate(account.type, undefined, { id: parent.id, type: parent.type, active: parent.active, isControl: parent.is_control })) throw new DomainError("INVALID_ACCOUNT_PARENT", "Choose an active ordinary parent of the same account type.");
  if (id) {
    const cycle = await client.query(`WITH RECURSIVE ancestors AS (SELECT id,parent_id FROM accounts WHERE organization_id=$1 AND legal_entity_id=$2 AND id=$3
      UNION SELECT a.id,a.parent_id FROM accounts a JOIN ancestors p ON a.id=p.parent_id WHERE a.organization_id=$1 AND a.legal_entity_id=$2)
      SELECT 1 FROM ancestors WHERE id=$4`, [org, entity, account.parentId, id]);
    if (cycle.rowCount) throw new DomainError("ACCOUNT_CYCLE", "An account cannot become its own descendant.");
  }
}
export async function listAccounts(user: string, org: string, entity: string, limit: number, cursor?: string) {
  return withScope(user, org, entity, "accounts.read", async client => {
    const rows = await client.query("SELECT * FROM accounts WHERE organization_id=$1 AND legal_entity_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4", [org, entity, cursor ?? null, limit + 1]);
    const data = rows.rows.slice(0, limit).map(dto); return { data, nextCursor: rows.rows.length > limit ? data.at(-1)!.id : null };
  });
}
export async function getAccount(user: string, org: string, entity: string, id: string) { return withScope(user, org, entity, "accounts.read", async client => dto(await selected(client, org, entity, id))); }
export async function createAccount(user: string, org: string, entity: string, input: z.input<typeof AccountCreate>, key: string, requestId: string) {
  const command = AccountCreate.parse(input);
  return withScope(user, org, entity, "accounts.create", async client => {
    await authorizeWrite(client, org, entity);
    const operation = `account.create:${entity}`, hash = contentHash(command);
    const prior = await replay(client, org, user, operation, key, hash); if (prior) return AccountDTO.parse(prior);
    await validateParent(client, org, entity, command);
    const id = randomUUID();
    const rows = await client.query(`INSERT INTO accounts(id,organization_id,legal_entity_id,code,name,type,normal_side,parent_id,is_control,control_type,report_section,cash_flow_category,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING *`, [id, org, entity, command.code, command.name, command.type, command.normalSide, command.parentId, command.isControl, command.controlType, command.reportMapping.statementSection, command.reportMapping.cashFlowCategory, user]);
    const response = dto(rows.rows[0]); await audit(client, org, user, "account.create", id, requestId, entity);
    await remember(client, org, user, operation, key, hash, id, response); return response;
  });
}
export async function patchAccount(user: string, org: string, entity: string, id: string, input: z.infer<typeof AccountPatch>, version: number, requestId: string) {
  const patch = AccountPatch.parse(input);
  return withScope(user, org, entity, "accounts.update", async client => {
    await authorizeWrite(client, org, entity); const old = dto(await selected(client, org, entity, id, true));
    if (old.version !== version) throw new DomainError("STALE_VERSION", "Reload the current account before editing.", 412);
    if (!old.active) throw new DomainError("ACCOUNT_ARCHIVED", "Archived accounts are immutable.", 409);
    const next = AccountCreate.parse({ code: old.code, name: patch.name ?? old.name, type: old.type, normalSide: old.normalSide, parentId: patch.parentId === undefined ? old.parentId : patch.parentId,
      isControl: old.isControl, controlType: old.controlType, reportMapping: patch.reportMapping ?? old.reportMapping });
    await validateParent(client, org, entity, next, id);
    const rows = await client.query("UPDATE accounts SET name=$2,parent_id=$3,report_section=$4,cash_flow_category=$5,version=version+1,updated_by=$6 WHERE id=$1 RETURNING *", [id, next.name, next.parentId, next.reportMapping.statementSection, next.reportMapping.cashFlowCategory, user]);
    await audit(client, org, user, "account.update", id, requestId, entity); return dto(rows.rows[0]);
  });
}
export async function archiveAccount(user: string, org: string, entity: string, id: string, input: z.infer<typeof Reason>, version: number, key: string, requestId: string) {
  const reason = Reason.parse(input);
  return withScope(user, org, entity, "accounts.update", async client => {
    await authorizeWrite(client, org, entity); const old = dto(await selected(client, org, entity, id, true));
    const operation = `account.archive:${entity}`, hash = contentHash({ id, version, ...reason });
    const prior = await replay(client, org, user, operation, key, hash); if (prior) return AccountDTO.parse(prior);
    if (old.version !== version) throw new DomainError("STALE_VERSION", "Reload the current account before archiving.", 412);
    if (!old.active) throw new DomainError("ACCOUNT_ARCHIVED", "This account is already archived.", 409);
    if ((await client.query("SELECT 1 FROM accounts WHERE organization_id=$1 AND legal_entity_id=$2 AND parent_id=$3 AND active", [org, entity, id])).rowCount) throw new DomainError("ACCOUNT_DEPENDENCIES", "Move or archive active children before archiving this account.", 409);
    const rows = await client.query("UPDATE accounts SET active=false,archived_by=$2,archived_at=clock_timestamp(),archive_reason=$3,version=version+1,updated_by=$2 WHERE id=$1 RETURNING *", [id, user, reason.reason]);
    const response = dto(rows.rows[0]); await audit(client, org, user, "account.archive", id, requestId, entity);
    await remember(client, org, user, operation, key, hash, id, response); return response;
  });
}
