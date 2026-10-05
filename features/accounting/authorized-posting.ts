import type { PoolClient } from "pg";
import { z } from "zod";
import { canonicalJSON, type JsonValue } from "@/domain/approvals";
import { prepareManualPosting } from "@/domain/posting";
import { DomainError } from "@/domain/errors";
import { withScope } from "@/features/identity/scope";

const SourceVersion = z.number().int().min(1).max(2147483647);
const Key = z.string().regex(/^[A-Za-z0-9_.-]{8,200}$/);
const RequestId = z.string().trim().min(1).max(200);
export const AuthorizedPostingReceipt = z.strictObject({
  resourceId: z.uuid(), sourceVersion: SourceVersion, status: z.literal("posted"), journalId: z.uuid(), number: z.string(),
  debit: z.string().regex(/^(?:0|[1-9]\d{0,17})\.\d{2}$/), credit: z.string().regex(/^(?:0|[1-9]\d{0,17})\.\d{2}$/), requestId: RequestId,
}).superRefine((value,ctx) => {
  if (value.debit !== value.credit || value.debit === "0.00") ctx.addIssue({code:"custom",path:["debit"],message:"A posting receipt must retain a positive exact balance."});
});
const statuses: Record<string, number> = { FORBIDDEN: 403, NOT_FOUND: 404, SELF_APPROVAL: 403, STALE_VERSION: 412,
  APPROVAL_INVALIDATED: 409, SOURCE_ALREADY_POSTED: 409, SOURCE_CONFLICT: 409, IDEMPOTENCY_CONFLICT: 409,
  APPROVAL_REQUIRED: 422, APPROVAL_POLICY_REQUIRED: 422, PERIOD_CLOSED: 422, RULE_NOT_VERIFIED: 422,
  INVALID_CONTENT: 422, INVALID_DIMENSION: 422, UNBALANCED_JOURNAL: 422, DECISION_CONFLICT: 409 };
async function query(client: PoolClient, sql: string, values: unknown[]) {
  try { return await client.query(sql, values); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P0001" && "message" in error && Object.hasOwn(statuses, String(error.message))) {
      const code = String(error.message); throw new DomainError(code, "The journal command failed its authorization, approval or source preconditions.", statuses[code]);
    }
    throw error;
  }
}
function scopeIds(org: string, entity: string, source: string, version: number) { z.uuid().parse(org); z.uuid().parse(entity); z.uuid().parse(source); SourceVersion.parse(version); }

// Trusted source producer only. No runtime EXECUTE grant or HTTP route.
// K014's draft/submission service must replace this operator-only boundary.
export async function prepareJournalSource(client: PoolClient, org: string, entity: string, source: string, version: number, input: unknown, requestId: string): Promise<string> {
  scopeIds(org,entity,source,version); RequestId.parse(requestId);
  const { posting } = prepareManualPosting(input);
  const result = await query(client, "SELECT app_security.prepare_journal_posting_source($1,$2,$3,$4,$5::jsonb,$6,$7) AS id", [org,entity,source,version,JSON.stringify(posting),canonicalJSON(posting as JsonValue),requestId]);
  return z.uuid().parse(result.rows[0].id);
}
export async function approveJournalSource(user: string, org: string, entity: string, source: string, version: number, reason: string, requestId: string) {
  scopeIds(org,entity,source,version); const checked = z.string().trim().min(3).max(1000).parse(reason); RequestId.parse(requestId);
  return withScope(user,org,entity,"journals.approve",async client => {
    const result = await query(client,"SELECT app_security.approve_journal_posting_source($1,$2,$3,$4,$5,$6) AS id",[org,entity,source,version,checked,requestId]);
    return z.uuid().parse(result.rows[0].id);
  });
}
// The transaction variant permits a future source adapter to append its own
// controlled effects before COMMIT; it never accepts a body or approval flag.
export async function postAuthorizedJournalInTransaction(client: PoolClient, org: string, entity: string, source: string, version: number, key: string, requestId: string) {
  scopeIds(org,entity,source,version); Key.parse(key); RequestId.parse(requestId);
  const result = await query(client,"SELECT app_security.post_authorized_journal($1,$2,$3,$4,$5,$6) AS result",[org,entity,source,version,key,requestId]);
  return AuthorizedPostingReceipt.parse(result.rows[0].result);
}
export async function postAuthorizedJournal(user: string, org: string, entity: string, source: string, version: number, key: string, requestId: string) {
  return withScope(user,org,entity,"journals.post",client => postAuthorizedJournalInTransaction(client,org,entity,source,version,key,requestId));
}
