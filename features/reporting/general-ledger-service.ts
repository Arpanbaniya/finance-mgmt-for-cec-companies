import { z } from "zod";
import { LedgerQuery, calculateLedgerPage } from "@/domain/general-ledger";
import { decimal, money } from "@/domain/money";
import { DomainError } from "@/domain/errors";
import { GeneralLedgerMetadata, GeneralLedgerResult } from "./contracts";
import { withLedgerReportScope } from "./scope";
import { decodeLedgerCursor, encodeLedgerCursor } from "./ledger-cursor";

/** Internal scoped account reader, not yet a public catalog ReportResult. */
export const GeneralLedgerSQL = `
WITH cutoff AS MATERIALIZED (
  SELECT coalesce($6::timestamptz,clock_timestamp()) AS known_at,clock_timestamp() AS generated_at
), visible AS MATERIALIZED (
  SELECT j.id AS journal_id,j.posting_date,j.document_date,j.created_at,j.source_type,j.source_id,j.event_kind,
    l.ordinal,l.account_version,l.debit,l.credit
  FROM journal_lines l JOIN journal_entries j ON j.organization_id=l.organization_id AND j.legal_entity_id=l.legal_entity_id AND j.id=l.journal_id
  CROSS JOIN cutoff c WHERE l.organization_id=$1 AND l.legal_entity_id=$2 AND l.account_id=$3
    AND j.posting_date<$5::date AND j.created_at<=c.known_at AND j.status='posted'
), master AS (
  SELECT a.id,v.version,v.snapshot FROM accounts a CROSS JOIN cutoff c
  JOIN account_versions v ON v.organization_id=a.organization_id AND v.legal_entity_id=a.legal_entity_id AND v.account_id=a.id
    AND v.version=coalesce((SELECT max(account_version) FROM visible),1)
  WHERE a.organization_id=$1 AND a.legal_entity_id=$2 AND a.id=$3 AND a.created_at<=c.known_at
), year AS (
  SELECT * FROM fiscal_years WHERE organization_id=$1 AND legal_entity_id=$2
    AND start_date<=($5::date-1) AND ($5::date-1)<end_date_exclusive
), totals AS (
  SELECT coalesce(sum(debit-credit) FILTER(WHERE posting_date<$4::date),0::numeric(20,2))::text AS opening,
    coalesce(sum(debit) FILTER(WHERE posting_date>=$4::date),0::numeric(20,2))::text AS debit,
    coalesce(sum(credit) FILTER(WHERE posting_date>=$4::date),0::numeric(20,2))::text AS credit,
    coalesce(sum(debit-credit),0::numeric(20,2))::text AS closing,
    count(*) FILTER(WHERE posting_date>=$4::date)::text AS line_count,
    count(DISTINCT journal_id)::text AS journal_count,max(created_at) AS watermark,
    coalesce(sum(debit-credit) FILTER(WHERE posting_date<$4::date OR ($7::date IS NOT NULL AND (posting_date,journal_id,ordinal)<=($7::date,$8::uuid,$9::integer))),0::numeric(20,2))::text AS preceding
  FROM visible
), page AS MATERIALIZED (
  SELECT * FROM visible WHERE posting_date>=$4::date
    AND ($7::date IS NULL OR (posting_date,journal_id,ordinal)>($7::date,$8::uuid,$9::integer))
  ORDER BY posting_date,journal_id,ordinal LIMIT $10
), retained AS (
  SELECT p.posting_date,p.journal_id,p.ordinal,jsonb_build_object('journalId',p.journal_id,'ordinal',p.ordinal,
    'postingDate',to_char(p.posting_date,'YYYY-MM-DD'),'documentDate',to_char(p.document_date,'YYYY-MM-DD'),
    'recordedAt',to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'accountVersion',p.account_version,'accountCode',v.snapshot->>'code','accountName',v.snapshot->>'name',
    'debit',p.debit::text,'credit',p.credit::text,'source',jsonb_build_object('type',p.source_type,'id',p.source_id,'eventKind',p.event_kind),
    'manualJournalId',d.id) AS row
  FROM page p JOIN account_versions v ON v.organization_id=$1 AND v.legal_entity_id=$2 AND v.account_id=$3 AND v.version=p.account_version
  LEFT JOIN manual_journal_drafts d ON d.organization_id=$1 AND d.legal_entity_id=$2 AND p.source_type='journal'
    AND d.id=p.source_id AND d.journal_id=p.journal_id AND d.status='posted'
)
SELECT m.id IS NOT NULL AS account_found,y.id IS NOT NULL AS year_found,c.known_at>c.generated_at AS future_cutoff,
  ($7::date IS NULL OR EXISTS(SELECT 1 FROM visible WHERE posting_date>=$4::date AND (posting_date,journal_id,ordinal)=($7::date,$8::uuid,$9::integer))) AS cursor_found,
  (SELECT count(*) FROM page) AS page_count,(SELECT count(*) FROM retained) AS retained_count,
  coalesce((SELECT jsonb_agg(row ORDER BY posting_date,journal_id,ordinal) FROM retained),'[]'::jsonb) AS rows,
  jsonb_build_object('id',m.id,'code',m.snapshot->>'code','name',m.snapshot->>'name','type',m.snapshot->>'type',
    'normalSide',m.snapshot->>'normal_side','headerVersion',m.version,'nameBasis','latest-visible-posted-version-or-initial') AS account,
  jsonb_build_object('openingBalance',t.opening,'periodDebit',t.debit,'periodCredit',t.credit,'closingBalance',t.closing,'lineCount',t.line_count) AS totals,t.preceding,
  jsonb_build_object('organizationId',$1::uuid,'entityId',$2::uuid,'currency',e.base_currency,'accountId',$3::uuid,
    'fromDate',$4::text,'toDateExclusive',$5::text,'asOfDate',to_char($5::date-1,'YYYY-MM-DD'),
    'knownAt',to_char(c.known_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'generatedAt',to_char(c.generated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'ledgerWatermark',to_char(t.watermark AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'journalCount',t.journal_count,
    'fiscalYearId',y.id,'fiscalYearStart',to_char(y.start_date,'YYYY-MM-DD'),'fiscalYearEndExclusive',to_char(y.end_date_exclusive,'YYYY-MM-DD'),
    'retainedEarningsAccountId',y.retained_earnings_account_id,'retainedEarningsAccountVersion',y.retained_earnings_account_version,
    'reportingProfile',e.reporting_profile,'policyStatus',e.policy_status,'reportVersion','general-ledger-v1','mappingBasis','posted-account-versions',
    'balanceConvention','debit-positive','watermarkScope','selected-account') AS metadata
FROM legal_entities e CROSS JOIN cutoff c CROSS JOIN totals t LEFT JOIN master m ON true LEFT JOIN year y ON true
WHERE e.organization_id=$1 AND e.id=$2`;

export async function readGeneralLedger(userId: string, organizationId: string, entityId: string, value: unknown) {
  const org = z.uuid().toLowerCase().parse(organizationId), entity = z.uuid().toLowerCase().parse(entityId), query = LedgerQuery.parse(value);
  return withLedgerReportScope(userId, org, entity, async client => {
    const cursor = query.cursor ? decodeLedgerCursor(query.cursor, org, entity, query) : null;
    const result = await client.query(GeneralLedgerSQL, [org, entity, query.accountId, query.fromDate, query.toDateExclusive,
      cursor?.knownAt ?? query.knownAt ?? null, cursor?.postingDate ?? null, cursor?.journalId ?? null, cursor?.ordinal ?? null, query.limit + 1]);
    const row = result.rows[0];
    if (!row || !row.account_found) throw new DomainError("NOT_FOUND", "Account is unavailable at this report cutoff.", 404);
    if (!row.year_found) throw new DomainError("FISCAL_YEAR_REQUIRED", "Configure the fiscal year containing the report's as-of date.");
    if (row.future_cutoff) throw new DomainError("INVALID_REPORT_CUTOFF", "The knowledge cutoff cannot be in the future.");
    if (!row.cursor_found) throw new DomainError("INVALID_CURSOR", "The cursor anchor is not a visible line of this account and report.", 400);
    if (row.page_count !== row.retained_count) throw new DomainError("INVALID_REPORT_MAPPING", "A retained account version is missing.");
    const metadata = GeneralLedgerMetadata.parse(row.metadata);
    const totals = row.totals as { openingBalance: string; periodDebit: string; periodCredit: string; closingBalance: string; lineCount: string };
    if (!decimal(totals.openingBalance).plus(totals.periodDebit).minus(totals.periodCredit).equals(decimal(totals.closingBalance))) throw new DomainError("UNBALANCED_REPORT", "Opening plus movement must equal closing exactly.");
    const page = calculateLedgerPage(money(row.preceding), row.rows.slice(0, query.limit)), last = page.rows.at(-1);
    const nextCursor = row.rows.length > query.limit && last ? encodeLedgerCursor({ version: 1, organizationId: org, entityId: entity,
      accountId: query.accountId, fromDate: query.fromDate, toDateExclusive: query.toDateExclusive, knownAt: metadata.knownAt,
      postingDate: last.postingDate, journalId: last.journalId, ordinal: last.ordinal }) : null;
    return GeneralLedgerResult.parse({ metadata, account: row.account, rows: page.rows, totals,
      page: { precedingBalance: money(row.preceding), endingBalance: page.endingBalance, nextCursor },
      limitations: ["A cursor encodes query context, not authority; permission and its database anchor are checked on each page.",
        "Manual source details use the existing authorized journal read; other source detail workflows and evidence are not enabled.",
        "This is a temporal read, not an approved durable close snapshot.", "Public report API and screens remain pending."] });
  });
}
