import type { PoolClient } from "pg";
import { z } from "zod";
import { SubledgerSourceInput } from "@/domain/subledger-source";
import { SubledgerCutoff } from "@/domain/subledger";
import { withScope } from "@/features/identity/scope";

const DecimalText = z.string().regex(/^(0|[1-9]\d{0,17})\.\d{2}$/);
export const OpenBalance = z.strictObject({
  id: z.uuid(), partyId: z.uuid(), side: z.enum(["ar", "ap"]), sourceId: z.uuid(), journalId: z.uuid(),
  postingDate: z.iso.date(), dueDate: z.iso.date(), originalAmount: DecimalText, allocatedAmount: DecimalText, outstandingAmount: DecimalText,
});
export const BalanceQuery = SubledgerCutoff.extend({ limit: z.number().int().min(1).max(100).default(25), after: z.uuid().optional() });
// Kept as one query so diagnostics exercise the same bounded scoped reader.
export const OpenBalancesSQL = `WITH page AS (
  SELECT * FROM subledger_open_items WHERE organization_id=$1 AND legal_entity_id=$2
  AND posting_date<=$3::date AND recorded_at<=$4::timestamptz AND ($5::uuid IS NULL OR id>$5) ORDER BY id LIMIT $6
), applied AS (
  SELECT a.open_item_id,sum(CASE WHEN a.reversal_of IS NULL THEN a.amount ELSE -a.amount END) AS amount
  FROM subledger_allocations a JOIN page p ON p.id=a.open_item_id
  WHERE a.organization_id=$1 AND a.legal_entity_id=$2 AND a.effective_date<=$3::date AND a.recorded_at<=$4::timestamptz GROUP BY a.open_item_id
) SELECT p.id,p.party_id AS "partyId",p.side,p.source_id AS "sourceId",p.journal_id AS "journalId",p.posting_date::text AS "postingDate",p.due_date::text AS "dueDate",
  p.amount::text AS "originalAmount",coalesce(a.amount,0.00)::numeric(20,2)::text AS "allocatedAmount",(p.amount-coalesce(a.amount,0.00))::numeric(20,2)::text AS "outstandingAmount"
  FROM page p LEFT JOIN applied a ON a.open_item_id=p.id ORDER BY p.id`;

/** No runtime EXECUTE grant; only trusted source adapters may use this seam. */
export async function writeSubledgerSource(client: PoolClient, org: string, entity: string, source: string, input: unknown, requestId: string) {
  z.uuid().parse(org); z.uuid().parse(entity); z.uuid().parse(source); z.string().trim().min(1).max(200).parse(requestId);
  const body = SubledgerSourceInput.parse(input);
  const result = await client.query<{ id: string }>("SELECT app_security.write_subledger_source($1,$2,$3,$4::jsonb,$5) AS id", [org, entity, source, JSON.stringify(body), requestId]);
  return z.uuid().parse(result.rows[0].id);
}

/** Bounded scoped reader; no hypothetical open-item HTTP route is added. */
export async function readOpenBalances(user: string, org: string, entity: string, value: unknown) {
  z.uuid().parse(org); z.uuid().parse(entity);
  const query = BalanceQuery.parse(value);
  return withScope(user, org, entity, "journals.read", async client => {
    const result = await client.query(
      OpenBalancesSQL,
      [org, entity, query.asOfDate, query.knownAt, query.after ?? null, query.limit + 1],
    );
    const data = result.rows.slice(0, query.limit).map(row => OpenBalance.parse(row));
    return { data, nextCursor: result.rows.length > query.limit ? data.at(-1)!.id : null, asOfDate: query.asOfDate, knownAt: query.knownAt, currency: "NPR" as const };
  });
}
