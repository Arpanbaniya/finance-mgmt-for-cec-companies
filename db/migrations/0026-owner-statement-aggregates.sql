-- A finite aggregate reader, not a raw-ledger RLS grant. The migration owner
-- is a separate operational trust boundary. Never expose arbitrary SQL here.
CREATE FUNCTION app_security.owner_statement_aggregates(
  org uuid, entity uuid, date_from date, date_to date, knowledge timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE payload jsonb;
BEGIN
  IF org::text IS DISTINCT FROM current_setting('app.org_id',true)
    OR entity::text IS DISTINCT FROM current_setting('app.entity_id',true)
    OR NOT app_security.can_entity(org,entity)
    OR NOT EXISTS(SELECT 1 FROM public.memberships m WHERE m.organization_id=org
      AND m.user_id=current_setting('app.user_id',true) AND m.active AND m.roles ? 'owner') THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Owner summary authority is required';
  END IF;
  IF date_from IS NULL OR date_to IS NULL OR NOT isfinite(date_from) OR NOT isfinite(date_to)
    OR date_from<DATE '0001-01-01' OR date_to>DATE '9999-12-31' OR date_from>=date_to
    OR (knowledge IS NOT NULL AND (NOT isfinite(knowledge) OR knowledge< TIMESTAMPTZ '0001-01-01 00:00:00+00')) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid statement interval';
  END IF;
  -- Membership edits and posting share this organization lock. Recheck after
  -- waiting so an in-flight revocation cannot authorize a subsequent read.
  PERFORM app_security.lock_policy_scope(org,entity);
  IF NOT app_security.can_entity(org,entity)
    OR NOT EXISTS(SELECT 1 FROM public.memberships m WHERE m.organization_id=org
      AND m.user_id=current_setting('app.user_id',true) AND m.active AND m.roles ? 'owner') THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Owner summary authority is required';
  END IF;
  WITH cutoff AS MATERIALIZED (
    SELECT coalesce(knowledge,clock_timestamp()) AS known_at,clock_timestamp() AS generated_at
  ), year AS MATERIALIZED (
    SELECT y.* FROM public.fiscal_years y WHERE y.organization_id=org AND y.legal_entity_id=entity
      AND y.start_date<=date_to-1 AND date_to-1<y.end_date_exclusive
  ), visible AS MATERIALIZED (
    SELECT j.id,j.posting_date,j.created_at FROM public.journal_entries j CROSS JOIN cutoff c
      WHERE j.organization_id=org AND j.legal_entity_id=entity AND j.posting_date<date_to AND j.created_at<=c.known_at
  ), movements AS MATERIALIZED (
    SELECT l.account_id,l.account_version,
      coalesce(sum(l.debit) FILTER(WHERE j.posting_date<date_from),0) AS opening_debit,
      coalesce(sum(l.credit) FILTER(WHERE j.posting_date<date_from),0) AS opening_credit,
      coalesce(sum(l.debit) FILTER(WHERE j.posting_date>=date_from),0) AS period_debit,
      coalesce(sum(l.credit) FILTER(WHERE j.posting_date>=date_from),0) AS period_credit,
      coalesce(sum(l.debit) FILTER(WHERE j.posting_date>=y.start_date),0) AS year_debit,
      coalesce(sum(l.credit) FILTER(WHERE j.posting_date>=y.start_date),0) AS year_credit
    FROM visible j JOIN public.journal_lines l ON l.organization_id=org AND l.legal_entity_id=entity AND l.journal_id=j.id
      CROSS JOIN year y GROUP BY l.account_id,l.account_version ORDER BY l.account_id,l.account_version LIMIT 10001
  ), retained AS MATERIALIZED (
    SELECT v.snapshot->>'type' AS type,v.snapshot->>'normal_side' AS normal_side,v.snapshot->>'report_section' AS section,
      coalesce(v.snapshot->>'profit_loss_category','unclassified') AS category,
      coalesce(v.snapshot->>'cost_behavior','unclassified') AS behavior,m.*
    FROM movements m JOIN public.account_versions v ON v.organization_id=org AND v.legal_entity_id=entity
      AND v.account_id=m.account_id AND v.version=m.account_version
  ), buckets AS (
    SELECT type,normal_side,section,category,behavior,
      sum(opening_debit)::text AS opening_debit,sum(opening_credit)::text AS opening_credit,
      sum(period_debit)::text AS period_debit,sum(period_credit)::text AS period_credit,
      sum(year_debit)::text AS year_debit,sum(year_credit)::text AS year_credit
    FROM retained GROUP BY type,normal_side,section,category,behavior
  )
  SELECT jsonb_build_object('buckets',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'type',type,'normalSide',normal_side,'statementSection',section,'profitLossCategory',category,'costBehavior',behavior,
      'openingDebit',opening_debit,'openingCredit',opening_credit,'periodDebit',period_debit,'periodCredit',period_credit,
      'yearDebit',year_debit,'yearCredit',year_credit) ORDER BY type,normal_side,section,category,behavior) FROM buckets),'[]'::jsonb),
    'metadata',jsonb_build_object('organizationId',org,'entityId',entity,'currency',e.base_currency,
      'fromDate',to_char(date_from,'YYYY-MM-DD'),'toDateExclusive',to_char(date_to,'YYYY-MM-DD'),'asOfDate',to_char(date_to-1,'YYYY-MM-DD'),
      'knownAt',to_char(c.known_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'generatedAt',to_char(c.generated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'ledgerWatermark',(SELECT to_char(max(created_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM visible),
      'fiscalYearId',y.id,'fiscalYearStart',to_char(y.start_date,'YYYY-MM-DD'),'fiscalYearEndExclusive',to_char(y.end_date_exclusive,'YYYY-MM-DD'),
      'reportingProfile',e.reporting_profile,'policyStatus',e.policy_status,'reportVersion','owner-statement-summary-v1','mappingBasis','posted-account-versions'),
    'futureCutoff',c.known_at>c.generated_at,'versionCount',(SELECT count(*) FROM movements),'retainedCount',(SELECT count(*) FROM retained)) INTO payload
    FROM public.legal_entities e CROSS JOIN cutoff c CROSS JOIN year y WHERE e.organization_id=org AND e.id=entity;
  IF payload IS NULL THEN RETURN NULL; END IF;
  IF (payload->>'futureCutoff')::boolean THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Knowledge cutoff cannot be in the future';
  END IF;
  IF (payload->>'versionCount')::integer>10000 THEN
    RAISE EXCEPTION USING ERRCODE='54000', MESSAGE='Statement aggregate limit exceeded';
  END IF;
  IF payload->>'versionCount' IS DISTINCT FROM payload->>'retainedCount' THEN
    RAISE EXCEPTION USING ERRCODE='22000', MESSAGE='Retained statement mapping is missing';
  END IF;
  -- No account IDs, names, source IDs, descriptions, actors, dimensions,
  -- journal counts, retained-equity account references or mapping witnesses.
  RETURN payload-ARRAY['futureCutoff','versionCount','retainedCount'];
END $$;
REVOKE ALL ON FUNCTION app_security.owner_statement_aggregates(uuid,uuid,date,date,timestamptz) FROM PUBLIC;
