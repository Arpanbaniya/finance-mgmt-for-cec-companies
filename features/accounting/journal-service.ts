import type { PoolClient } from "pg";
import type { z } from "zod";
import { DomainError } from "@/domain/errors";
import { prepareManualPosting } from "@/domain/posting";
import { withScope } from "@/features/identity/scope";
import { Reason } from "@/features/alerts/contracts";
import { JournalCreate, JournalPatch, JournalDTO, JournalCancelResult, JournalCommandResult, JournalNoBody, DateAction } from "./journal-contracts";
import { canonicalJSON, type JsonValue } from "@/domain/approvals";
import { Transition } from "@/features/approvals/contracts";

function dto(row: Record<string, unknown>) {
  const instant = (value: unknown) => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
  const { totals } = prepareManualPosting(row.body);
  const review = row.review as { approvals: { createdAt: string }[] } | null | undefined;
  return JournalDTO.parse({ ...(row.body as object), id: row.id, organizationId: row.organization_id, entityId: row.legal_entity_id,
    sourceType: "journal", sourceId: row.id, eventKind: row.reversal_of ? "reverse" : "manual", status: row.reversal_journal_id ? "reversed" : row.status, version: row.version,
    debit: totals.debit, credit: totals.credit, createdBy: row.created_by, updatedBy: row.updated_by,
    createdAt: instant(row.created_at), updatedAt: instant(row.updated_at), cancelReason: row.cancel_reason,
    journalId: row.journal_id ?? null, number: row.number ?? null, transitionReason: row.transition_reason ?? null,
    reversalOf: row.reversal_of ?? null, reversalOfSourceId: row.reversal_of_source_id ?? null, reversalRequestId: row.reversal_request_id ?? null, reversalJournalId: row.reversal_journal_id ?? null,
    review: review ? { ...review, approvals: review.approvals.map(approval => ({ ...approval, createdAt: instant(approval.createdAt) })) } : null });
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
        MAKER_REQUIRED: ["The original maker must submit this journal.", 403], SELF_APPROVAL: ["A creator or editor cannot review their own journal.", 403],
        ALREADY_APPROVED: ["You have already approved this submission.", 409], APPROVAL_REQUIRED: ["Independent current approvals must meet the frozen threshold.", 422],
        APPROVAL_INVALIDATED: ["Accounts, scope or policy changed. Edit and resubmit this journal.", 409],
        APPROVAL_POLICY_REQUIRED: ["An active applicable journal approval policy is required.", 422], PERIOD_CLOSED: ["Posting requires an open fiscal period.", 422],
        RULE_NOT_VERIFIED: ["Only a fictional demo policy is available for manual posting.", 422],
        REVERSAL_SOURCE_UNSUPPORTED: ["Use the controlled workflow of the original source. Only ordinary manual postings can be reversed here.", 422],
        REVERSAL_DEPENDENCY: ["A dependent financial or close record blocks reversal.", 409], ALREADY_REVERSED: ["The original journal already has a posted reversal.", 409],
        REVERSAL_PENDING: ["Open or cancel the existing reversal draft before requesting another.", 409],
        REVERSAL_CONTENT_LOCKED: ["Reversal dates and exact inverse lines cannot be changed. Cancel and request a new dated reversal instead.", 422],
        REVERSAL_DATE: ["Reversal cannot precede the original posting date.", 422],
      };
      if (errors[code]) throw new DomainError(code, ...errors[code]);
    }
    throw error;
  }
}
const journalProjection = `SELECT d.*,j.number,r.original_journal_id AS reversal_of,r.original_draft_id AS reversal_of_source_id,
  pending.draft_id AS reversal_request_id,completed.reversal_journal_id
  FROM manual_journal_drafts d
  LEFT JOIN journal_entries j ON j.organization_id=d.organization_id AND j.legal_entity_id=d.legal_entity_id AND j.id=d.journal_id
  LEFT JOIN manual_journal_reversal_requests r ON r.organization_id=d.organization_id AND r.legal_entity_id=d.legal_entity_id AND r.draft_id=d.id
  LEFT JOIN manual_journal_reversals completed ON completed.organization_id=d.organization_id AND completed.legal_entity_id=d.legal_entity_id AND completed.original_journal_id=d.journal_id
  LEFT JOIN LATERAL (SELECT rr.draft_id FROM manual_journal_reversal_requests rr JOIN manual_journal_drafts child ON child.id=rr.draft_id
    WHERE rr.organization_id=d.organization_id AND rr.legal_entity_id=d.legal_entity_id AND rr.original_draft_id=d.id AND child.status<>'cancelled'
    ORDER BY rr.created_at DESC,rr.draft_id DESC LIMIT 1) pending ON true`;
export async function listJournals(user: string, org: string, entity: string, limit: number, cursor?: string) {
  return withScope(user, org, entity, "journals.read", async client => {
    const rows = await client.query(`${journalProjection} WHERE d.organization_id=$1 AND d.legal_entity_id=$2 AND ($3::uuid IS NULL OR d.id>$3) ORDER BY d.id LIMIT $4`, [org, entity, cursor ?? null, limit + 1]);
    const data = rows.rows.slice(0, limit).map(dto); return { data, nextCursor: rows.rows.length > limit ? data.at(-1)!.id : null };
  });
}
export async function getJournal(user: string, org: string, entity: string, id: string) {
  return withScope(user, org, entity, "journals.read", async client => sqlCommand(async () => {
    const rows = await client.query(`${journalProjection.replace("SELECT d.*,", "SELECT d.*,app_security.manual_journal_review($1,$2,d.id) AS review,")} WHERE d.organization_id=$1 AND d.legal_entity_id=$2 AND d.id=$3`, [org, entity, id]);
    if (!rows.rowCount) throw new DomainError("NOT_FOUND", "Journal is unavailable.", 404);
    return dto(rows.rows[0]);
  }));
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

type JournalAction = "submit" | "approve" | "reject" | "post" | "reverse";
export function availableJournalActions(journal: z.infer<typeof JournalDTO>, user: string, permissions: Set<string>): JournalAction[] {
  const actions: JournalAction[] = [];
  if (journal.status === "draft" && journal.createdBy === user && permissions.has("journals.submit")) actions.push("submit");
  if (["submitted", "approved"].includes(journal.status) && journal.review && permissions.has("journals.approve") && (journal.review.canApprove || journal.review.approvals.some(approval => approval.actorId === user))) {
    if (journal.review.snapshotValid && journal.review.canApprove) actions.push("approve");
    actions.push("reject");
  }
  if (journal.status === "approved" && journal.review?.snapshotValid && journal.review.validApprovals >= journal.review.requiredApprovals && permissions.has("journals.post")) actions.push("post");
  if (journal.status === "posted" && !journal.reversalOf && !journal.reversalRequestId && permissions.has("journals.reverse")) actions.push("reverse");
  return actions;
}
async function transitionJournal(user: string, org: string, entity: string, id: string, action: Exclude<JournalAction, "reverse">, reason: string | undefined, version: number, key: string, requestId: string) {
  const permission = action === "reject" ? "journals.approve" : `journals.${action}`;
  return withScope(user, org, entity, permission, client => sqlCommand(async () => {
    let canonical: string | null = null;
    if (action === "submit") {
      await client.query("SELECT app_security.lock_policy_scope($1,$2)", [org, entity]);
      canonical = canonicalJSON((await selected(client, org, entity, id)).body as JsonValue);
    }
    const rows = await client.query("SELECT app_security.transition_manual_journal($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result", [org, entity, id, version, action, reason ?? null, key, canonical, requestId]);
    return JournalCommandResult.parse(rows.rows[0].result);
  }));
}
export async function submitJournal(user: string, org: string, entity: string, id: string, input: z.infer<typeof Transition>, version: number, key: string, requestId: string) {
  return transitionJournal(user, org, entity, id, "submit", Transition.parse(input).reason, version, key, requestId);
}
export async function approveJournal(user: string, org: string, entity: string, id: string, input: z.infer<typeof Transition>, version: number, key: string, requestId: string) {
  return transitionJournal(user, org, entity, id, "approve", Transition.parse(input).reason, version, key, requestId);
}
export async function rejectJournal(user: string, org: string, entity: string, id: string, input: z.infer<typeof Reason>, version: number, key: string, requestId: string) {
  return transitionJournal(user, org, entity, id, "reject", Reason.parse(input).reason, version, key, requestId);
}
export async function postJournal(user: string, org: string, entity: string, id: string, input: z.infer<typeof JournalNoBody>, version: number, key: string, requestId: string) {
  JournalNoBody.parse(input);
  return transitionJournal(user, org, entity, id, "post", undefined, version, key, requestId);
}
export async function reverseJournal(user: string, org: string, entity: string, id: string, input: z.infer<typeof DateAction>, version: number, key: string, requestId: string) {
  const command = DateAction.parse(input);
  return withScope(user, org, entity, "journals.reverse", client => sqlCommand(async () => {
    const rows = await client.query("SELECT app_security.request_manual_journal_reversal($1,$2,$3,$4,$5,$6,$7,$8) AS result", [org, entity, id, version, command.postingDate, command.reason, key, requestId]);
    return JournalCommandResult.parse(rows.rows[0].result);
  }));
}
