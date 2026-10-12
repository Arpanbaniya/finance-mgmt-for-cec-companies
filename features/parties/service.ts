import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { z } from "zod";
import { DomainError } from "@/domain/errors";
import { contentHash } from "@/domain/approvals";
import { withScope } from "@/features/identity/scope";
import { audit } from "@/features/platform/service";
import { replay, remember } from "@/features/platform/idempotency";
import { ListQuery } from "@/features/platform/contracts";
import { Reason } from "@/features/alerts/contracts";
import { PartyCreate, PartyPatch, PartyDTO } from "./contracts";

function dto(row: Record<string, unknown>) {
  return PartyDTO.parse({ id: row.id, organizationId: row.organization_id, entityId: row.legal_entity_id, name: row.name, roleSet: row.role_set,
    contact: row.contact, address: row.address, taxIdentifier: row.tax_identifier, paymentTermsDays: row.payment_terms_days, creditLimit: row.credit_limit,
    active: row.active, version: row.version, createdBy: row.created_by, updatedBy: row.updated_by,
    createdAt: (row.created_at as Date).toISOString(), updatedAt: (row.updated_at as Date).toISOString(),
    archivedBy: row.archived_by, archivedAt: row.archived_at ? (row.archived_at as Date).toISOString() : null, archiveReason: row.archive_reason });
}
async function authorizeWrite(client: PoolClient, org: string, entity: string) {
  await client.query("SELECT app_security.lock_policy_scope($1,$2)", [org, entity]);
  const access = await client.query("SELECT app_security.can_manage_accounts($1) AND app_security.finance_setup_scope($1,$2) AS allowed", [org, entity]);
  if (!access.rows[0].allowed) throw new DomainError("FORBIDDEN", "Current finance manager authority is required.", 403);
}
async function selected(client: PoolClient, org: string, entity: string, id: string, lock = false) {
  const result = await client.query(`SELECT * FROM parties WHERE organization_id=$1 AND legal_entity_id=$2 AND id=$3${lock ? " FOR UPDATE" : ""}`, [org, entity, id]);
  if (!result.rowCount) throw new DomainError("NOT_FOUND", "Party is unavailable.", 404);
  return dto(result.rows[0]);
}
export async function listParties(user: string, org: string, entity: string, limit: number, cursor?: string) {
  const query = ListQuery.parse({ limit, cursor });
  return withScope(user, org, entity, "parties.read", async client => {
    const rows = await client.query("SELECT * FROM parties WHERE organization_id=$1 AND legal_entity_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4", [org, entity, query.cursor ?? null, query.limit + 1]);
    const data = rows.rows.slice(0, query.limit).map(dto); return { data, nextCursor: rows.rows.length > query.limit ? data.at(-1)!.id : null };
  });
}
export async function getParty(user: string, org: string, entity: string, id: string) {
  return withScope(user, org, entity, "parties.read", client => selected(client, org, entity, id));
}
export async function createParty(user: string, org: string, entity: string, input: z.input<typeof PartyCreate>, key: string, requestId: string) {
  const command = PartyCreate.parse(input);
  return withScope(user, org, entity, "parties.create", async client => {
    await authorizeWrite(client, org, entity);
    const operation = `party.create:${entity}`, hash = contentHash(command);
    const prior = await replay(client, org, user, operation, key, hash); if (prior) return PartyDTO.parse(prior);
    const rows = await client.query(`INSERT INTO parties(id,organization_id,legal_entity_id,name,role_set,contact,address,tax_identifier,payment_terms_days,credit_limit,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`, [randomUUID(), org, entity, command.name, JSON.stringify(command.roleSet), command.contact, command.address, command.taxIdentifier, command.paymentTermsDays, command.creditLimit, user]);
    const response = dto(rows.rows[0]); await audit(client, org, user, "party.create", response.id, requestId, entity);
    await remember(client, org, user, operation, key, hash, response.id, response); return response;
  });
}
export async function patchParty(user: string, org: string, entity: string, id: string, input: z.input<typeof PartyPatch>, version: number, requestId: string) {
  const patch = PartyPatch.parse(input);
  return withScope(user, org, entity, "parties.update", async client => {
    await authorizeWrite(client, org, entity); const old = await selected(client, org, entity, id, true);
    if (old.version !== version) throw new DomainError("STALE_VERSION", "Reload the current party before editing.", 412);
    if (!old.active) throw new DomainError("PARTY_ARCHIVED", "Archived parties cannot be edited.", 409);
    const next = PartyCreate.parse({ name: old.name, roleSet: old.roleSet, contact: old.contact, address: old.address, taxIdentifier: old.taxIdentifier, paymentTermsDays: old.paymentTermsDays, creditLimit: old.creditLimit, ...patch });
    const rows = await client.query(`UPDATE parties SET name=$2,role_set=$3,contact=$4,address=$5,tax_identifier=$6,payment_terms_days=$7,credit_limit=$8,version=version+1,updated_by=$9
      WHERE id=$1 RETURNING *`, [id, next.name, JSON.stringify(next.roleSet), next.contact, next.address, next.taxIdentifier, next.paymentTermsDays, next.creditLimit, user]);
    await audit(client, org, user, "party.update", id, requestId, entity); return dto(rows.rows[0]);
  });
}
export async function archiveParty(user: string, org: string, entity: string, id: string, input: z.infer<typeof Reason>, version: number, key: string, requestId: string) {
  const reason = Reason.parse(input);
  return withScope(user, org, entity, "parties.update", async client => {
    await authorizeWrite(client, org, entity); const old = await selected(client, org, entity, id, true);
    const operation = `party.archive:${entity}`, hash = contentHash({ id, version, ...reason });
    const prior = await replay(client, org, user, operation, key, hash); if (prior) return PartyDTO.parse(prior);
    if (old.version !== version) throw new DomainError("STALE_VERSION", "Reload the current party before archiving.", 412);
    if (!old.active) throw new DomainError("PARTY_ARCHIVED", "This party is already archived.", 409);
    const rows = await client.query("UPDATE parties SET active=false,archived_by=$2,archived_at=clock_timestamp(),archive_reason=$3,version=version+1,updated_by=$2 WHERE id=$1 RETURNING *", [id, user, reason.reason]);
    const response = dto(rows.rows[0]); await audit(client, org, user, "party.archive", id, requestId, entity);
    await remember(client, org, user, operation, key, hash, id, response); return response;
  });
}
