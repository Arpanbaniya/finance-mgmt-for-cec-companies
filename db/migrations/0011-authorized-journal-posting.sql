-- K013 source-consumption protocol. Source production remains operator-only
-- until the K014 draft/submission adapter is implemented. Raw ledger EXECUTE
-- stays denied; runtime approval/posting accepts only a persisted source ID.
CREATE TABLE journal_posting_sources (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL,
  source_id uuid NOT NULL, source_version integer NOT NULL CHECK(source_version>0),
  maker_id text NOT NULL REFERENCES auth_user(id), body jsonb NOT NULL, canonical_body text NOT NULL,
  content_hash text NOT NULL, amount numeric(20,2) NOT NULL CHECK(amount>0 AND amount<=999999999999999999.99),
  policy_id uuid NOT NULL, policy_version integer NOT NULL CHECK(policy_version=2),
  policy_definition jsonb NOT NULL, threshold jsonb NOT NULL,
  entity_version integer NOT NULL, mapping_revision_id uuid, branch_snapshots jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(canonical_body::jsonb=body), CHECK(content_hash=encode(sha256(convert_to(canonical_body,'UTF8')),'hex')),
  UNIQUE(organization_id,legal_entity_id,id), UNIQUE(organization_id,legal_entity_id,source_id,source_version),
  FOREIGN KEY(organization_id,legal_entity_id) REFERENCES legal_entities(organization_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,policy_id) REFERENCES approval_policies(organization_id,legal_entity_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,mapping_revision_id) REFERENCES account_mapping_revisions(organization_id,legal_entity_id,id)
);
CREATE TABLE journal_posting_decisions (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL, command_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES auth_user(id), content_hash text NOT NULL, reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(command_id,actor_id),
  FOREIGN KEY(organization_id,legal_entity_id,command_id) REFERENCES journal_posting_sources(organization_id,legal_entity_id,id)
);
CREATE TABLE journal_source_postings (
  organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL, source_id uuid NOT NULL,
  command_id uuid NOT NULL UNIQUE, journal_id uuid NOT NULL UNIQUE, posted_by text NOT NULL REFERENCES auth_user(id),
  result jsonb NOT NULL, posted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,legal_entity_id,source_id),
  FOREIGN KEY(organization_id,legal_entity_id,command_id) REFERENCES journal_posting_sources(organization_id,legal_entity_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,journal_id) REFERENCES journal_entries(organization_id,legal_entity_id,id)
);
CREATE TABLE journal_posting_results (
  organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL, principal_id text NOT NULL REFERENCES auth_user(id),
  operation text NOT NULL CHECK(operation='journal.post'), key text NOT NULL CHECK(key ~ '^[A-Za-z0-9_.-]{8,200}$'),
  source_id uuid NOT NULL, source_version integer NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,legal_entity_id,principal_id,operation,key),
  FOREIGN KEY(organization_id,legal_entity_id,source_id,source_version) REFERENCES journal_posting_sources(organization_id,legal_entity_id,source_id,source_version)
);
-- Immutable typed outbox payload; delivery receipts/consumers are separate.
CREATE TABLE journal_posting_events (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind='journal.posted'), source_id uuid NOT NULL, source_version integer NOT NULL,
  journal_id uuid NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,legal_entity_id,kind,source_id),
  FOREIGN KEY(organization_id,legal_entity_id,journal_id) REFERENCES journal_entries(organization_id,legal_entity_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,source_id,source_version) REFERENCES journal_posting_sources(organization_id,legal_entity_id,source_id,source_version)
);

CREATE FUNCTION app_security.journal_principal_eligible(org uuid,entity uuid,actor text,approver boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM public.memberships WHERE organization_id=org AND user_id=actor AND active AND allowed_entity_ids ? entity::text
    AND (roles ? 'finance_manager' OR (NOT approver AND roles ? 'accountant')))
$$;
CREATE FUNCTION app_security.journal_source_dependencies_valid(command uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.journal_posting_sources; current_branches jsonb; current_mapping uuid;
BEGIN
  SELECT * INTO c FROM public.journal_posting_sources WHERE id=command;
  IF c.id IS NULL OR NOT app_security.journal_principal_eligible(c.organization_id,c.legal_entity_id,c.maker_id,false)
    OR c.source_version<>(SELECT max(source_version) FROM public.journal_posting_sources WHERE organization_id=c.organization_id AND legal_entity_id=c.legal_entity_id AND source_id=c.source_id)
    OR NOT EXISTS(SELECT 1 FROM public.legal_entities WHERE organization_id=c.organization_id AND id=c.legal_entity_id AND version=c.entity_version AND policy_status='demo' AND base_currency='NPR' AND reporting_profile='demo_accrual')
    OR NOT EXISTS(SELECT 1 FROM public.approval_policies WHERE id=c.policy_id AND organization_id=c.organization_id AND legal_entity_id=c.legal_entity_id AND version=c.policy_version AND status='active' AND definition=c.policy_definition)
    THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(c.body->'lines') l WHERE NOT EXISTS(SELECT 1 FROM public.accounts a
    WHERE a.organization_id=c.organization_id AND a.legal_entity_id=c.legal_entity_id AND a.id=(l->>'accountId')::uuid AND a.version=(l->>'accountVersion')::integer AND a.active AND NOT a.is_control)) THEN RETURN false; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.id),'[]'::jsonb) INTO current_branches FROM public.branches b WHERE b.organization_id=c.organization_id AND b.legal_entity_id=c.legal_entity_id
    AND b.id IN (SELECT (l->'dimensions'->>'branchId')::uuid FROM jsonb_array_elements(c.body->'lines') l WHERE l->'dimensions' ? 'branchId');
  SELECT id INTO current_mapping FROM public.account_mapping_revisions WHERE organization_id=c.organization_id AND legal_entity_id=c.legal_entity_id AND effective_from<=(c.body->>'postingDate')::date ORDER BY effective_from DESC LIMIT 1;
  RETURN current_branches=c.branch_snapshots AND current_mapping IS NOT DISTINCT FROM c.mapping_revision_id;
END $$;

CREATE FUNCTION app_security.prepare_journal_posting_source(org uuid,entity uuid,source uuid,revision integer,body jsonb,canonical text,request text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.journal_posting_sources; p public.approval_policies; entity_row public.legal_entities;
  threshold_row jsonb; line jsonb; debit_sum numeric:=0; credit_sum numeric:=0; mapping uuid; branches_snapshot jsonb; branch_count integer;
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  IF NOT app_security.finance_setup_scope(org,entity) OR NOT app_security.journal_principal_eligible(org,entity,current_setting('app.user_id',true),false) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF source IS NULL OR revision IS NULL OR revision<1 OR body IS NULL OR canonical IS NULL OR canonical::jsonb<>body OR request IS NULL OR length(btrim(request)) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
  SELECT * INTO c FROM public.journal_posting_sources WHERE organization_id=org AND legal_entity_id=entity AND source_id=source AND source_version=revision;
  IF c.id IS NOT NULL THEN
    IF c.body IS DISTINCT FROM body OR c.maker_id IS DISTINCT FROM current_setting('app.user_id',true) THEN RAISE EXCEPTION 'SOURCE_CONFLICT'; END IF;
    RETURN c.id;
  END IF;
  IF EXISTS(SELECT 1 FROM public.journal_source_postings WHERE organization_id=org AND legal_entity_id=entity AND source_id=source)
    OR EXISTS(SELECT 1 FROM public.journal_entries WHERE organization_id=org AND legal_entity_id=entity AND source_type='journal' AND source_id=source)
    THEN RAISE EXCEPTION 'SOURCE_ALREADY_POSTED'; END IF;
  IF revision<>(SELECT coalesce(max(source_version),0)+1 FROM public.journal_posting_sources WHERE organization_id=org AND legal_entity_id=entity AND source_id=source)
    OR EXISTS(SELECT 1 FROM public.journal_posting_sources WHERE organization_id=org AND legal_entity_id=entity AND source_id=source AND maker_id<>current_setting('app.user_id',true)) THEN RAISE EXCEPTION 'STALE_VERSION'; END IF;
  -- The trusted producer uses domain/posting before entering this function.
  -- Validate monetary facts again so the frozen threshold cannot be fabricated.
  IF jsonb_typeof(body) IS DISTINCT FROM 'object' OR NOT body ?& ARRAY['postingDate','documentDate','description','currency','lines']
    OR body-ARRAY['postingDate','documentDate','description','currency','lines']<>'{}'::jsonb OR body->>'currency' IS DISTINCT FROM 'NPR'
    OR jsonb_typeof(body->'lines') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
  IF jsonb_array_length(body->'lines') NOT BETWEEN 2 AND 500 THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(body->'lines') LOOP
    IF jsonb_typeof(line->'debit') IS DISTINCT FROM 'string' OR jsonb_typeof(line->'credit') IS DISTINCT FROM 'string'
      OR (line->>'debit') !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,2})?$' OR (line->>'credit') !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,2})?$'
      OR NOT (((line->>'debit')::numeric>0 AND (line->>'credit')::numeric=0) OR ((line->>'credit')::numeric>0 AND (line->>'debit')::numeric=0)) THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
    debit_sum:=debit_sum+(line->>'debit')::numeric; credit_sum:=credit_sum+(line->>'credit')::numeric;
    IF NOT EXISTS(SELECT 1 FROM public.accounts WHERE organization_id=org AND legal_entity_id=entity AND id=(line->>'accountId')::uuid AND version=(line->>'accountVersion')::integer AND active AND NOT is_control) THEN RAISE EXCEPTION 'APPROVAL_INVALIDATED'; END IF;
  END LOOP;
  IF debit_sum<>credit_sum OR debit_sum>999999999999999999.99 THEN RAISE EXCEPTION 'UNBALANCED_JOURNAL'; END IF;
  SELECT * INTO entity_row FROM public.legal_entities WHERE organization_id=org AND id=entity FOR SHARE;
  IF entity_row.policy_status<>'demo' OR entity_row.reporting_profile<>'demo_accrual' THEN RAISE EXCEPTION 'RULE_NOT_VERIFIED'; END IF;
  SELECT * INTO p FROM public.approval_policies WHERE organization_id=org AND legal_entity_id=entity AND status='active' AND definition->'aggregateTypes' ? 'journal'
    AND (definition->>'effectiveFrom')::date<=(body->>'postingDate')::date AND ((definition->>'effectiveTo') IS NULL OR (body->>'postingDate')::date<(definition->>'effectiveTo')::date);
  IF p.id IS NULL THEN RAISE EXCEPTION 'APPROVAL_POLICY_REQUIRED'; END IF;
  SELECT value INTO threshold_row FROM jsonb_array_elements(p.definition->'thresholds') WHERE (value->>'minInclusive')::numeric<=debit_sum AND ((value->>'maxExclusive') IS NULL OR debit_sum<(value->>'maxExclusive')::numeric);
  IF threshold_row IS NULL OR threshold_row->>'requiredPermission'<>'journals.approve' THEN RAISE EXCEPTION 'APPROVAL_POLICY_REQUIRED'; END IF;
  SELECT id INTO mapping FROM public.account_mapping_revisions WHERE organization_id=org AND legal_entity_id=entity AND effective_from<=(body->>'postingDate')::date ORDER BY effective_from DESC LIMIT 1;
  PERFORM 1 FROM public.branches b WHERE b.organization_id=org AND b.legal_entity_id=entity AND b.id IN (SELECT (l->'dimensions'->>'branchId')::uuid FROM jsonb_array_elements(body->'lines') l WHERE l->'dimensions' ? 'branchId') ORDER BY b.id FOR SHARE;
  SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.id),'[]'::jsonb),count(*) INTO branches_snapshot,branch_count FROM public.branches b WHERE b.organization_id=org AND b.legal_entity_id=entity
    AND b.id IN (SELECT (l->'dimensions'->>'branchId')::uuid FROM jsonb_array_elements(body->'lines') l WHERE l->'dimensions' ? 'branchId');
  IF branch_count<>(SELECT count(DISTINCT l->'dimensions'->>'branchId') FROM jsonb_array_elements(body->'lines') l WHERE l->'dimensions' ? 'branchId') THEN RAISE EXCEPTION 'INVALID_DIMENSION'; END IF;
  INSERT INTO public.journal_posting_sources(id,organization_id,legal_entity_id,source_id,source_version,maker_id,body,canonical_body,content_hash,amount,policy_id,policy_version,policy_definition,threshold,entity_version,mapping_revision_id,branch_snapshots)
    VALUES(gen_random_uuid(),org,entity,source,revision,current_setting('app.user_id',true),body,canonical,encode(sha256(convert_to(canonical,'UTF8')),'hex'),debit_sum,p.id,p.version,p.definition,threshold_row,entity_row.version,mapping,branches_snapshot) RETURNING * INTO c;
  INSERT INTO public.audit_events(id,organization_id,legal_entity_id,actor_id,action,target_id,request_id) VALUES(gen_random_uuid(),org,entity,c.maker_id,'journal.source_submitted',source,request);
  RETURN c.id;
END $$;

CREATE FUNCTION app_security.approve_journal_posting_source(org uuid,entity uuid,source uuid,revision integer,reason text,request text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.journal_posting_sources; previous public.journal_posting_decisions; actor text:=current_setting('app.user_id',true); decision uuid;
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  IF NOT app_security.finance_setup_scope(org,entity) OR NOT app_security.journal_principal_eligible(org,entity,actor,true) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  SELECT * INTO c FROM public.journal_posting_sources WHERE organization_id=org AND legal_entity_id=entity AND source_id=source AND source_version=revision;
  IF c.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF c.maker_id=actor THEN RAISE EXCEPTION 'SELF_APPROVAL'; END IF;
  IF reason IS NULL OR length(btrim(reason)) NOT BETWEEN 3 AND 1000 OR request IS NULL OR length(btrim(request)) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
  PERFORM 1 FROM public.legal_entities WHERE organization_id=org AND id=entity FOR SHARE;
  PERFORM 1 FROM public.branches b WHERE b.organization_id=org AND b.legal_entity_id=entity AND b.id IN (SELECT (l->'dimensions'->>'branchId')::uuid FROM jsonb_array_elements(c.body->'lines') l WHERE l->'dimensions' ? 'branchId') ORDER BY b.id FOR SHARE;
  IF NOT app_security.journal_source_dependencies_valid(c.id) THEN RAISE EXCEPTION 'APPROVAL_INVALIDATED'; END IF;
  IF EXISTS(SELECT 1 FROM public.journal_source_postings WHERE organization_id=org AND legal_entity_id=entity AND source_id=source) THEN RAISE EXCEPTION 'SOURCE_ALREADY_POSTED'; END IF;
  SELECT * INTO previous FROM public.journal_posting_decisions WHERE command_id=c.id AND actor_id=actor;
  IF previous.id IS NOT NULL THEN
    IF previous.reason<>btrim(reason) THEN RAISE EXCEPTION 'DECISION_CONFLICT'; END IF;
    RETURN previous.id;
  END IF;
  INSERT INTO public.journal_posting_decisions(id,organization_id,legal_entity_id,command_id,actor_id,content_hash,reason)
    VALUES(gen_random_uuid(),org,entity,c.id,actor,c.content_hash,btrim(reason)) RETURNING id INTO decision;
  INSERT INTO public.audit_events(id,organization_id,legal_entity_id,actor_id,action,target_id,request_id) VALUES(gen_random_uuid(),org,entity,actor,'journal.source_approved',source,request);
  RETURN decision;
END $$;

CREATE FUNCTION app_security.post_authorized_journal(org uuid,entity uuid,source uuid,revision integer,key text,request text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.journal_posting_sources; prior public.journal_posting_results; consumed public.journal_source_postings;
  header public.journal_entries; response jsonb; actor text:=current_setting('app.user_id',true); period_id uuid;
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  IF NOT app_security.finance_setup_scope(org,entity) OR NOT app_security.journal_principal_eligible(org,entity,actor,true) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF source IS NULL OR revision IS NULL OR revision<1 OR key IS NULL OR key !~ '^[A-Za-z0-9_.-]{8,200}$' OR request IS NULL OR length(btrim(request)) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
  SELECT * INTO prior FROM public.journal_posting_results WHERE organization_id=org AND legal_entity_id=entity AND principal_id=actor AND operation='journal.post' AND journal_posting_results.key=post_authorized_journal.key;
  IF prior.key IS NOT NULL THEN
    IF prior.source_id<>source OR prior.source_version<>revision THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN prior.result;
  END IF;
  SELECT * INTO c FROM public.journal_posting_sources WHERE organization_id=org AND legal_entity_id=entity AND source_id=source AND source_version=revision;
  IF c.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  SELECT * INTO consumed FROM public.journal_source_postings WHERE organization_id=org AND legal_entity_id=entity AND source_id=source;
  IF consumed.command_id IS NOT NULL THEN
    IF consumed.command_id<>c.id THEN RAISE EXCEPTION 'SOURCE_ALREADY_POSTED'; END IF;
    response:=consumed.result;
  ELSE
    SELECT id INTO period_id FROM public.fiscal_periods WHERE organization_id=org AND legal_entity_id=entity AND start_date<=(c.body->>'postingDate')::date AND (c.body->>'postingDate')::date<end_date_exclusive AND state='open' FOR UPDATE;
    IF period_id IS NULL THEN RAISE EXCEPTION 'PERIOD_CLOSED'; END IF;
    PERFORM 1 FROM public.legal_entities WHERE organization_id=org AND id=entity FOR SHARE;
    PERFORM 1 FROM public.branches b WHERE b.organization_id=org AND b.legal_entity_id=entity AND b.id IN (SELECT (l->'dimensions'->>'branchId')::uuid FROM jsonb_array_elements(c.body->'lines') l WHERE l->'dimensions' ? 'branchId') ORDER BY b.id FOR SHARE;
    IF NOT app_security.journal_source_dependencies_valid(c.id) THEN RAISE EXCEPTION 'APPROVAL_INVALIDATED'; END IF;
    IF (SELECT count(*) FROM public.journal_posting_decisions d WHERE d.command_id=c.id AND d.content_hash=c.content_hash AND d.actor_id<>c.maker_id
      AND app_security.journal_principal_eligible(org,entity,d.actor_id,true))<(c.threshold->>'numberOfDistinctApprovers')::integer THEN RAISE EXCEPTION 'APPROVAL_REQUIRED'; END IF;
    SELECT * INTO header FROM app_security.write_manual_journal(org,entity,source,c.body,request);
    response:=jsonb_build_object('resourceId',source,'sourceVersion',revision,'status','posted','journalId',header.id,'number',header.number,'debit',header.total_debit::text,'credit',header.total_credit::text,'requestId',request);
    INSERT INTO public.journal_source_postings(organization_id,legal_entity_id,source_id,command_id,journal_id,posted_by,result) VALUES(org,entity,source,c.id,header.id,actor,response);
    INSERT INTO public.journal_posting_events(id,organization_id,legal_entity_id,kind,source_id,source_version,journal_id) VALUES(gen_random_uuid(),org,entity,'journal.posted',source,revision,header.id);
    INSERT INTO public.audit_events(id,organization_id,legal_entity_id,actor_id,action,target_id,request_id) VALUES(gen_random_uuid(),org,entity,actor,'journal.source_posted',source,request);
  END IF;
  INSERT INTO public.journal_posting_results(organization_id,legal_entity_id,principal_id,operation,key,source_id,source_version,result) VALUES(org,entity,actor,'journal.post',key,source,revision,response);
  RETURN response;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['journal_posting_sources','journal_posting_decisions','journal_source_postings','journal_posting_results','journal_posting_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY posting_scoped_read ON %I FOR SELECT USING (app_security.finance_setup_scope(organization_id,legal_entity_id) AND app_security.can_read_accounts(organization_id))',t);
    EXECUTE format('CREATE TRIGGER posting_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_security.append_only()',t);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION app_security.journal_principal_eligible(uuid,uuid,text,boolean),app_security.journal_source_dependencies_valid(uuid),
  app_security.prepare_journal_posting_source(uuid,uuid,uuid,integer,jsonb,text,text),app_security.approve_journal_posting_source(uuid,uuid,uuid,integer,text,text),
  app_security.post_authorized_journal(uuid,uuid,uuid,integer,text,text) FROM PUBLIC;
