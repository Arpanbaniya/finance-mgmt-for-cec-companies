import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { reconcilePartyStatement, StatementQuery } from "@/domain/party-statement";
import { withScope } from "@/features/identity/scope";
import { PartyStatement } from "./statement-contracts";
import { decodeStatementCursor, encodeStatementCursor } from "./statement-query";

// One statement snapshot: bounded activity, complete aggregates, independently
// reconstructed open items/capacity, retained control classifications only.
export const PartyStatementSQL = `WITH cutoff AS MATERIALIZED (
  SELECT coalesce($6::timestamptz,clock_timestamp()) AS known_at,clock_timestamp() AS generated_at
), master AS MATERIALIZED (
  SELECT v.* FROM party_versions v CROSS JOIN cutoff c
  WHERE v.organization_id=$1 AND v.legal_entity_id=$2 AND v.party_id=$3
    AND greatest(v.recorded_at,(v.snapshot->>'updated_at')::timestamptz)<=c.known_at
  ORDER BY v.version DESC LIMIT 1
), visible AS MATERIALIZED (
  SELECT s.*,j.created_at AS journal_recorded_at FROM subledger_sources s
  JOIN journal_entries j ON j.organization_id=$1 AND j.legal_entity_id=$2 AND j.id=s.journal_id CROSS JOIN cutoff c
  WHERE s.organization_id=$1 AND s.legal_entity_id=$2 AND s.party_id=$3
    AND s.posting_date<=$5::date AND s.recorded_at<=c.known_at AND j.created_at<=c.known_at
), effects AS MATERIALIZED (
  SELECT s.id,s.posting_date,v.snapshot->>'control_type' AS book,
    CASE WHEN v.snapshot->>'control_type' IN ('ar','supplier_advances') THEN l.debit-l.credit ELSE l.credit-l.debit END AS delta
  FROM visible s JOIN journal_lines l ON l.organization_id=$1 AND l.legal_entity_id=$2 AND l.journal_id=s.journal_id
  JOIN account_versions v ON v.organization_id=$1 AND v.legal_entity_id=$2 AND v.account_id=l.account_id AND v.version=l.account_version
  WHERE v.snapshot->>'control_type' IN ('ar','ap','customer_deposits','supplier_advances')
), allocations AS MATERIALIZED (
  SELECT a.*,CASE WHEN a.reversal_of IS NULL THEN a.amount ELSE -a.amount END AS signed_amount
  FROM subledger_allocations a JOIN visible v ON v.id=a.source_id
  WHERE a.organization_id=$1 AND a.legal_entity_id=$2 AND a.effective_date<=$5::date
), target_usage AS (
  SELECT open_item_id,sum(signed_amount) AS closing,sum(signed_amount) FILTER(WHERE effective_date<$4::date) AS opening
  FROM allocations GROUP BY open_item_id
), capacity_usage AS (
  SELECT settlement_id,sum(signed_amount) AS closing,sum(signed_amount) FILTER(WHERE effective_date<$4::date) AS opening
  FROM allocations GROUP BY settlement_id
), items AS MATERIALIZED (
  SELECT i.side AS book,i.due_date,i.amount-coalesce(u.closing,0) AS closing,
    CASE WHEN i.posting_date<$4::date THEN i.amount-coalesce(u.opening,0) ELSE 0 END AS opening
  FROM subledger_open_items i JOIN visible v ON v.id=i.source_id LEFT JOIN target_usage u ON u.open_item_id=i.id
  WHERE i.organization_id=$1 AND i.legal_entity_id=$2 AND i.party_id=$3
), capacities AS (
  SELECT CASE WHEN s.side='ar' THEN 'customer_deposits' ELSE 'supplier_advances' END AS book,
    s.amount-coalesce(u.closing,0) AS closing,
    CASE WHEN s.posting_date<$4::date THEN s.amount-coalesce(u.opening,0) ELSE 0 END AS opening
  FROM subledger_settlements s JOIN visible v ON v.id=s.source_id LEFT JOIN capacity_usage u ON u.settlement_id=s.id
  WHERE s.organization_id=$1 AND s.legal_entity_id=$2 AND s.party_id=$3 AND s.mode='on_account'
), subledger AS (SELECT book,opening,closing FROM items UNION ALL SELECT book,opening,closing FROM capacities),
books(book) AS (VALUES ('ar'),('ap'),('customer_deposits'),('supplier_advances')),
balances AS (
  SELECT b.book,coalesce(sum(e.delta) FILTER(WHERE e.posting_date<$4::date),0)::numeric::text AS opening,
    coalesce(sum(e.delta) FILTER(WHERE e.posting_date>=$4::date AND e.delta>0),0)::numeric::text AS increases,
    coalesce(sum(-e.delta) FILTER(WHERE e.posting_date>=$4::date AND e.delta<0),0)::numeric::text AS decreases,
    coalesce(sum(e.delta),0)::numeric::text AS closing,
    (SELECT coalesce(sum(s.opening),0)::numeric::text FROM subledger s WHERE s.book=b.book) AS "subledgerOpening",
    (SELECT coalesce(sum(s.closing),0)::numeric::text FROM subledger s WHERE s.book=b.book) AS "subledgerClosing"
  FROM books b LEFT JOIN effects e ON e.book=b.book GROUP BY b.book
), aged AS (
  SELECT b.book AS side,coalesce(sum(i.closing) FILTER(WHERE i.due_date>=$5::date),0)::numeric::text AS current,
    coalesce(sum(i.closing) FILTER(WHERE $5::date-i.due_date BETWEEN 1 AND 30),0)::numeric::text AS "days1To30",
    coalesce(sum(i.closing) FILTER(WHERE $5::date-i.due_date BETWEEN 31 AND 60),0)::numeric::text AS "days31To60",
    coalesce(sum(i.closing) FILTER(WHERE $5::date-i.due_date BETWEEN 61 AND 90),0)::numeric::text AS "days61To90",
    coalesce(sum(i.closing) FILTER(WHERE $5::date-i.due_date>90),0)::numeric::text AS "daysOver90"
  FROM books b LEFT JOIN items i ON i.book=b.book WHERE b.book IN ('ar','ap') GROUP BY b.book
), page AS MATERIALIZED (
  SELECT * FROM visible WHERE posting_date>=$4::date
    AND ($7::date IS NULL OR (posting_date,id)>($7::date,$8::uuid)) ORDER BY posting_date,id LIMIT $9
), activity AS (
  SELECT p.posting_date,p.id,jsonb_build_object('sourceId',p.id,'journalId',p.journal_id,'kind',p.kind,
    'postingDate',p.posting_date::text,'documentDate',p.document_date::text,'amount',p.amount::text,
    'recordedAt',to_char(p.journal_recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'effects',jsonb_object_agg(b.book,coalesce(e.delta,0)::numeric::text)) AS row
  FROM page p CROSS JOIN books b LEFT JOIN effects e ON e.id=p.id AND e.book=b.book
  GROUP BY p.id,p.posting_date,p.journal_id,p.kind,p.document_date,p.amount,p.journal_recorded_at
)
SELECT c.known_at>c.generated_at AS future_cutoff,m.party_id IS NOT NULL AS party_found,
  ($7::date IS NULL OR EXISTS(SELECT 1 FROM visible WHERE posting_date>=$4::date AND (posting_date,id)=($7::date,$8::uuid))) AS cursor_found,
  jsonb_build_object('id',m.party_id,'name',m.snapshot->>'name','version',m.version,'active',(m.snapshot->>'active')::boolean,
    'nameBasis','retained-master-at-knowledge-cutoff') AS party,
  jsonb_build_object('organizationId',$1::uuid,'entityId',$2::uuid,'partyId',$3::uuid,'currency',e.base_currency,
    'fromDate',$4::text,'asOfDate',$5::text,'knownAt',to_char(c.known_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'generatedAt',to_char(c.generated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'ledgerWatermark',(SELECT to_char(max(journal_recorded_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM visible),
    'sourceCount',(SELECT count(*)::text FROM visible),'reportVersion','party-statement-v1','mappingBasis','posted-account-versions',
    'balanceConvention','separate-normal-positive-books') AS metadata,
  (SELECT jsonb_agg(to_jsonb(b) ORDER BY book) FROM balances b) AS balances,
  (SELECT jsonb_agg(to_jsonb(a) ORDER BY side) FROM aged a) AS ageing,
  coalesce((SELECT jsonb_agg(row ORDER BY posting_date,id) FROM activity),'[]'::jsonb) AS activity
FROM legal_entities e CROSS JOIN cutoff c LEFT JOIN master m ON true WHERE e.organization_id=$1 AND e.id=$2`;

function amounts(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === "0" ? "0.00" : v]));
}
export async function readPartyStatement(user: string, organization: string, company: string, counterparty: string, value: unknown) {
  const id = z.uuid().toLowerCase(), org = id.parse(organization), entity = id.parse(company), party = id.parse(counterparty);
  const query = StatementQuery.parse(value);
  return withScope(user, org, entity, "parties.read", async client => {
    await client.query("SET LOCAL lock_timeout='2s'"); await client.query("SET LOCAL statement_timeout='5s'");
    await client.query("SELECT app_security.lock_policy_scope($1,$2)", [org, entity]);
    const cursor = query.cursor ? decodeStatementCursor(query.cursor, org, entity, party, query) : null;
    const result = await client.query(PartyStatementSQL, [org, entity, party, query.fromDate, query.asOfDate,
      cursor?.knownAt ?? query.knownAt ?? null, cursor?.postingDate ?? null, cursor?.sourceId ?? null, query.limit + 1]);
    const row = result.rows[0];
    if (row?.future_cutoff) throw new DomainError("INVALID_REPORT_CUTOFF", "The knowledge cutoff cannot be in the future.");
    if (!row?.party_found) throw new DomainError("NOT_FOUND", "Party is unavailable at this statement cutoff.", 404);
    if (!row.cursor_found) throw new DomainError("INVALID_CURSOR", "Statement cursor does not identify a visible source.", 400);
    const reconciled = reconcilePartyStatement(row.balances.map(amounts), row.ageing.map(amounts));
    const activity = row.activity.slice(0, query.limit).map((a: Record<string, unknown>) => ({ ...a, effects: amounts(a.effects as Record<string, unknown>) }));
    const last = activity.at(-1);
    const nextCursor = row.activity.length > query.limit ? encodeStatementCursor({ version: 1, organizationId: org, entityId: entity, partyId: party,
      fromDate: query.fromDate, asOfDate: query.asOfDate, knownAt: row.metadata.knownAt, postingDate: last.postingDate, sourceId: last.sourceId }) : null;
    return PartyStatement.parse({ metadata: row.metadata, party: row.party, ...reconciled, activity, nextCursor,
      limitations: ["Only committed party-linked source journals are included; drafts and collection promises are excluded.",
        "AR, AP, customer deposits and supplier advances remain separate; there is no net party balance.",
        "Ageing uses retained open-item due dates, not current master payment terms.",
        "This is a temporal read, not an approved durable close snapshot or statutory statement.",
        "Invoice, payment and refund workflows remain unavailable until their dedicated source modules are released."] });
  });
}
