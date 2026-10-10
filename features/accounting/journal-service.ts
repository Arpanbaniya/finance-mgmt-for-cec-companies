import type { PoolClient } from "pg";
import type { z } from "zod";
import { DomainError } from "@/domain/errors";
import { prepareManualPosting } from "@/domain/posting";
import { withScope } from "@/features/identity/scope";
import { Reason } from "@/features/alerts/contracts";
import { JournalCreate, JournalPatch, JournalDTO, JournalCancelResult } from "./journal-contracts";

function dto(row: Record<string, unknown>) {
  const instant = (value: unknown) => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
  const { totals } = prepareManualPosting(row.body);
  return JournalDTO.parse({ ...(row.body as object), id: row.id, organizationId: row.organization_id, entityId: row.legal_entity_id,
    sourceType: "journal", sourceId: row.id, eventKind: "manual", status: row.status, version: row.version,
    debit: totals.debit, credit: totals.credit, createdBy: row.created_by, updatedBy: row.updated_by,
    createdAt: instant(row.created_at), updatedAt: instant(row.updated_at), cancelReason: row.cancel_reason });
}
async function selected(client: PoolClient, org: string, entity: string, id: string) {
  const rows = await client.query("SELECT * FROM manual_journal_drafts WHERE organization_id=$1 AND legal_entity_id=$2 AND id=$3", [org, entity, id]);
  if (!rows.rowCount) throw new DomainError("NOT_FOUND", "Journal draft is unavailable.", 404);
  return rows.rows[0];
}
async function sqlCommand<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "P0001" && "message" in error) {
      const code = String(error.message);
      const errors: Record<string, [string, number]> = {
        FORBIDDEN: ["Current accountant or finance manager authority is required.", 403], NOT_FOUND: ["Journal draft is unavailable.", 404],
        STALE_VERSION: ["Reload the current draft before saving.", 412], INVALID_STATE: ["Only editable drafts can be changed or cancelled.", 409],
        IDEMPOTENCY_CONFLICT: ["This key was used with a different journal command.", 409], INVALID_CONTENT: ["Check the journal fields.", 422],
        ACCOUNT_UNAVAILABLE: ["Choose active accounts from this company.", 422], CONTROL_ACCOUNT_FORBIDDEN: ["Control accounts require their dedicated financial workflow.", 422],
        DIMENSION_UNAVAILABLE: ["Choose a branch from this company.", 422], UNBALANCED_JOURNAL: ["Debits and credits must balance exactly within the supported range.", 422],
      };
      if (errors[code]) throw new DomainError(code, ...errors[code]);
    }
    throw error;
  }
}
export async function listJournals(user: string, org: string, entity: string, limit: number, cursor?: string) {
  return withScope(user, org, entity, "journals.read", async client => {
    const rows = await client.query("SELECT * FROM manual_journal_drafts WHERE organization_id=$1 AND legal_entity_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4", [org, entity, cursor ?? null, limit + 1]);
    const data = rows.rows.slice(0, limit).map(dto); return { data, nextCursor: rows.rows.length > limit ? data.at(-1)!.id : null };
  });
}
export async function getJournal(user: string, org: string, entity: string, id: string) {
  return withScope(user, org, entity, "journals.read", async client => dto(await selected(client, org, entity, id)));
}
export async function createJournal(user: string, org: string, entity: string, input: z.input<typeof JournalCreate>, key: string, requestId: string) {
  const command = JournalCreate.parse(input);
  return withScope(user, org, entity, "journals.create", client => sqlCommand(async () => {
    const rows = await client.query("SELECT app_security.save_manual_journal_draft($1,$2,NULL,NULL,$3,$4,$5) AS result", [org, entity, JSON.stringify(command), key, requestId]);
    return dto(rows.rows[0].result);
  }));
}
export async function patchJournal(user: string, org: string, entity: string, id: string, input: z.input<typeof JournalPatch>, version: number, requestId: string) {
  const patch = JournalPatch.parse(input);
  return withScope(user, org, entity, "journals.update", client => sqlCommand(async () => {
    // Serialize before reading the base for an omitted-field merge.
    await client.query("SELECT app_security.lock_policy_scope($1,$2)", [org, entity]);
    const old = dto(await selected(client, org, entity, id));
    const command = JournalCreate.parse({ postingDate: old.postingDate, documentDate: old.documentDate, description: old.description,
      lines: old.lines.map(({ accountId, debit, credit, dimensions }) => ({ accountId, debit, credit, dimensions })), ...patch });
    const rows = await client.query("SELECT app_security.save_manual_journal_draft($1,$2,$3,$4,$5,NULL,$6) AS result", [org, entity, id, version, JSON.stringify(command), requestId]);
    return dto(rows.rows[0].result);
  }));
}
export async function cancelJournal(user: string, org: string, entity: string, id: string, input: z.infer<typeof Reason>, version: number, key: string, requestId: string) {
  const reason = Reason.parse(input);
  return withScope(user, org, entity, "journals.update", client => sqlCommand(async () => {
    const rows = await client.query("SELECT app_security.cancel_manual_journal_draft($1,$2,$3,$4,$5,$6,$7) AS result", [org, entity, id, version, reason.reason, key, requestId]);
    return JournalCancelResult.parse(rows.rows[0].result);
  }));
}
