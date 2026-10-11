import { z } from "zod";
import { AccountMovement, calculateStatements, StatementInterval } from "@/domain/statements";
import { DomainError } from "@/domain/errors";
import { withLedgerReportScope } from "./scope";
import { StatementMetadata } from "./contracts";

// One scoped aggregate scan; money stays numeric in PostgreSQL and strings at
// the boundary. No raw journal payload, actor or private dimension is returned.
export const StatementAggregatesSQL = `
WITH cutoff AS MATERIALIZED (
  SELECT coalesce($5::timestamptz,clock_timestamp()) AS known_at, clock_timestamp() AS generated_at
), year AS MATERIALIZED (
  SELECT * FROM fiscal_years WHERE organization_id=$1 AND legal_entity_id=$2
    AND start_date<=($4::date-1) AND ($4::date-1)<end_date_exclusive
), visible AS MATERIALIZED (
  SELECT j.id,j.posting_date,j.created_at FROM journal_entries j CROSS JOIN cutoff
  WHERE j.organization_id=$1 AND j.legal_entity_id=$2 AND j.posting_date<$4::date AND j.created_at<=cutoff.known_at
), aggregate_rows AS (
  SELECT l.account_id,l.account_version,
    coalesce(sum(l.debit) FILTER(WHERE j.posting_date<$3::date),0)::text AS opening_debit,
    coalesce(sum(l.credit) FILTER(WHERE j.posting_date<$3::date),0)::text AS opening_credit,
    coalesce(sum(l.debit) FILTER(WHERE j.posting_date>=$3::date),0)::text AS period_debit,
    coalesce(sum(l.credit) FILTER(WHERE j.posting_date>=$3::date),0)::text AS period_credit,
    coalesce(sum(l.debit) FILTER(WHERE j.posting_date>=year.start_date),0)::text AS year_debit,
    coalesce(sum(l.credit) FILTER(WHERE j.posting_date>=year.start_date),0)::text AS year_credit
  FROM visible j JOIN journal_lines l ON l.organization_id=$1 AND l.legal_entity_id=$2 AND l.journal_id=j.id
  CROSS JOIN year GROUP BY l.account_id,l.account_version ORDER BY l.account_id,l.account_version LIMIT 10001
), retained AS (
  SELECT jsonb_build_object('accountId',a.account_id,'accountVersion',a.account_version,
    'code',v.snapshot->>'code','name',v.snapshot->>'name','type',v.snapshot->>'type',
    'normalSide',v.snapshot->>'normal_side','statementSection',v.snapshot->>'report_section',
    'openingDebit',a.opening_debit,'openingCredit',a.opening_credit,'periodDebit',a.period_debit,'periodCredit',a.period_credit,
    'yearDebit',a.year_debit,'yearCredit',a.year_credit) AS row
  FROM aggregate_rows a JOIN account_versions v ON v.organization_id=$1 AND v.legal_entity_id=$2
    AND v.account_id=a.account_id AND v.version=a.account_version
)
SELECT coalesce((SELECT jsonb_agg(row) FROM retained),'[]'::jsonb) AS rows,
  jsonb_build_object('organizationId',$1::uuid,'entityId',$2::uuid,'currency',e.base_currency,
    'fromDate',$3::text,'toDateExclusive',$4::text,'asOfDate',to_char($4::date-1,'YYYY-MM-DD'),
    'knownAt',to_char(c.known_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'generatedAt',to_char(c.generated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'ledgerWatermark',(SELECT to_char(max(created_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM visible),
    'journalCount',(SELECT count(*)::text FROM visible),
    'fiscalYearId',y.id,'fiscalYearStart',to_char(y.start_date,'YYYY-MM-DD'),
    'fiscalYearEndExclusive',to_char(y.end_date_exclusive,'YYYY-MM-DD'),
    'retainedEarningsAccountId',y.retained_earnings_account_id,'retainedEarningsAccountVersion',y.retained_earnings_account_version,
    'reportingProfile',e.reporting_profile,'policyStatus',e.policy_status,
    'reportVersion','statement-foundation-v1','mappingBasis','posted-account-versions') AS metadata,
  c.known_at>c.generated_at AS future_cutoff,
  (SELECT count(*) FROM aggregate_rows) AS aggregate_count,
  (SELECT count(*) FROM retained) AS retained_count
FROM legal_entities e CROSS JOIN cutoff c CROSS JOIN year y
WHERE e.organization_id=$1 AND e.id=$2`;

/** Internal read foundation; not yet a public ReportResult or catalog handler. */
export async function readStatementFoundation(userId: string, organizationId: string, entityId: string, value: unknown) {
  z.uuid().parse(organizationId); z.uuid().parse(entityId);
  const query = StatementInterval.parse(value);
  return withLedgerReportScope(userId, organizationId, entityId, async client => {
    const result = await client.query(StatementAggregatesSQL, [organizationId, entityId, query.fromDate, query.toDateExclusive, query.knownAt ?? null]);
    if (!result.rowCount) throw new DomainError("FISCAL_YEAR_REQUIRED", "Configure the fiscal year containing the report's as-of date.");
    const row = result.rows[0];
    if (row.future_cutoff) throw new DomainError("INVALID_REPORT_CUTOFF", "The knowledge cutoff cannot be in the future.");
    if (Number(row.aggregate_count) > 10000) throw new DomainError("REPORT_TOO_LARGE", "This report exceeds the retained-account aggregate limit; no partial totals are returned.");
    if (row.aggregate_count !== row.retained_count) throw new DomainError("INVALID_REPORT_MAPPING", "A retained account version is missing.");
    const movements = z.array(AccountMovement).max(10000).parse(row.rows.map((movement: Record<string, unknown>) => ({ ...movement,
      ...Object.fromEntries(["openingDebit", "openingCredit", "periodDebit", "periodCredit", "yearDebit", "yearCredit"].map(key => [key, movement[key] === "0" ? "0.00" : movement[key]])),
    })));
    return { metadata: StatementMetadata.parse(row.metadata), ...calculateStatements(movements),
      limitations: ["Income-tax/direct-cost classifications and comparative reporting are not implemented.",
        "Prior unclosed results are presented separately, not silently transferred to retained earnings.",
        "This temporal read is not an approved durable close snapshot or year-close workflow.",
        "Public report contracts, owner-only aggregates and report screens remain pending."] };
  });
}
