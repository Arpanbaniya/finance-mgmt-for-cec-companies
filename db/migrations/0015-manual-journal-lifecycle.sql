-- Only scoped draft transitions may consume a manual journal source.
ALTER TABLE manual_journal_drafts DROP CONSTRAINT manual_journal_drafts_status_check;
ALTER TABLE manual_journal_drafts DROP CONSTRAINT manual_journal_drafts_check;
ALTER TABLE manual_journal_drafts ADD COLUMN current_command_id uuid, ADD COLUMN submission_count integer NOT NULL DEFAULT 0 CHECK(submission_count>=0),
  ADD COLUMN journal_id uuid, ADD COLUMN transition_reason text;
ALTER TABLE manual_journal_drafts ADD CONSTRAINT manual_journal_status CHECK(status IN ('draft','submitted','approved','posted','cancelled')),
  ADD CONSTRAINT manual_journal_cancellation CHECK((status<>'cancelled' AND cancel_reason IS NULL) OR (status='cancelled' AND length(btrim(cancel_reason)) BETWEEN 3 AND 1000)),
  ADD CONSTRAINT manual_journal_state_source CHECK((status IN ('draft','cancelled') AND current_command_id IS NULL) OR (status IN ('submitted','approved','posted') AND current_command_id IS NOT NULL AND submission_count>0)),
  ADD CONSTRAINT manual_journal_state_ledger CHECK((status='posted' AND journal_id IS NOT NULL) OR (status<>'posted' AND journal_id IS NULL)),
  ADD FOREIGN KEY(organization_id,legal_entity_id,current_command_id) REFERENCES journal_posting_sources(organization_id,legal_entity_id,id),
  ADD FOREIGN KEY(organization_id,legal_entity_id,journal_id) REFERENCES journal_entries(organization_id,legal_entity_id,id);
ALTER TABLE manual_journal_results DROP CONSTRAINT manual_journal_results_operation_check;
ALTER TABLE manual_journal_results ADD CONSTRAINT manual_journal_result_operation CHECK(operation IN ('journal.draft.create','journal.draft.cancel','journal.submit','journal.approve','journal.reject','journal.post'));

CREATE TABLE manual_journal_execution_permits (
  organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL, draft_id uuid NOT NULL, command_id uuid NOT NULL,
  principal_id text NOT NULL, action text NOT NULL CHECK(action IN ('approve','post')), transaction_id xid8 NOT NULL,
  PRIMARY KEY(organization_id,legal_entity_id,draft_id,action,transaction_id),
  FOREIGN KEY(organization_id,legal_entity_id,draft_id) REFERENCES manual_journal_drafts(organization_id,legal_entity_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,command_id) REFERENCES journal_posting_sources(organization_id,legal_entity_id,id)
);
ALTER TABLE manual_journal_execution_permits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON manual_journal_execution_permits FROM PUBLIC;

CREATE FUNCTION app_security.manual_journal_actor_is_author(org uuid,entity uuid,draft uuid,actor text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM public.manual_journal_drafts WHERE organization_id=org AND legal_entity_id=entity AND id=draft AND created_by=actor)
    OR EXISTS(SELECT 1 FROM public.audit_events WHERE organization_id=org AND legal_entity_id=entity AND target_id=draft AND actor_id=actor AND action='journal.draft.update')
$$;
CREATE FUNCTION app_security.manual_journal_approval_count(command uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT count(*)::integer FROM public.journal_posting_decisions d JOIN public.journal_posting_sources s ON s.id=d.command_id
    WHERE d.command_id=command AND d.content_hash=s.content_hash AND app_security.journal_principal_eligible(s.organization_id,s.legal_entity_id,d.actor_id,true)
      AND NOT app_security.manual_journal_actor_is_author(s.organization_id,s.legal_entity_id,s.source_id,d.actor_id)
$$;

CREATE FUNCTION app_security.transition_manual_journal(org uuid,entity uuid,draft uuid,expected integer,action text,reason text,key text,canonical text,request text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.manual_journal_drafts; c public.journal_posting_sources; prior public.manual_journal_results;
  command jsonb; response jsonb; ledger jsonb; actor text:=current_setting('app.user_id',true); operation text:='journal.'||action;
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  IF NOT app_security.finance_setup_scope(org,entity) OR action IS NULL OR action NOT IN ('submit','approve','reject','post')
    OR NOT app_security.journal_principal_eligible(org,entity,actor,action<>'submit') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF draft IS NULL OR expected IS NULL OR expected<1 OR key IS NULL OR key !~ '^[A-Za-z0-9_.-]{8,200}$' OR request IS NULL OR length(btrim(request)) NOT BETWEEN 1 AND 200
    OR (reason IS NOT NULL AND length(btrim(reason)) NOT BETWEEN 3 AND 1000) OR (action='reject' AND reason IS NULL)
    OR (action<>'submit' AND canonical IS NOT NULL) OR (action='post' AND reason IS NOT NULL) THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
  command:=jsonb_build_object('id',draft,'version',expected,'reason',CASE WHEN reason IS NULL THEN NULL ELSE btrim(reason) END);
  SELECT * INTO prior FROM public.manual_journal_results r WHERE r.organization_id=org AND r.legal_entity_id=entity AND r.principal_id=actor AND r.operation=transition_manual_journal.operation AND r.key=transition_manual_journal.key;
  IF prior.draft_id IS NOT NULL THEN
    IF prior.request_body IS DISTINCT FROM command THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN prior.result;
  END IF;
  SELECT * INTO d FROM public.manual_journal_drafts WHERE organization_id=org AND legal_entity_id=entity AND id=draft FOR UPDATE;
  IF d.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  -- A consumed source with a new principal/key still returns the committed result.
  IF action='post' AND d.status='posted' THEN
    SELECT r.result INTO response FROM public.manual_journal_results r WHERE r.organization_id=org AND r.legal_entity_id=entity AND r.draft_id=draft AND r.operation='journal.post' ORDER BY r.key LIMIT 1;
    IF response IS NULL THEN RAISE EXCEPTION 'INVALID_STATE'; END IF;
    INSERT INTO public.manual_journal_results VALUES(org,entity,actor,operation,key,command,draft,response);
    RETURN response;
  END IF;
  IF d.version<>expected THEN RAISE EXCEPTION 'STALE_VERSION'; END IF;
  IF action='submit' THEN
    IF d.created_by<>actor THEN RAISE EXCEPTION 'MAKER_REQUIRED'; END IF;
    IF d.status<>'draft' THEN RAISE EXCEPTION 'INVALID_STATE'; END IF;
    IF canonical IS NULL OR canonical::jsonb IS DISTINCT FROM d.body THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
    d.current_command_id:=app_security.prepare_journal_posting_source(org,entity,draft,d.submission_count+1,d.body,canonical,request);
    d.submission_count:=d.submission_count+1; d.status:='submitted';
  ELSE
    IF d.status NOT IN ('submitted','approved') THEN RAISE EXCEPTION 'INVALID_STATE'; END IF;
    SELECT * INTO c FROM public.journal_posting_sources WHERE id=d.current_command_id AND organization_id=org AND legal_entity_id=entity;
    IF action IN ('approve','reject') AND app_security.manual_journal_actor_is_author(org,entity,draft,actor) THEN RAISE EXCEPTION 'SELF_APPROVAL'; END IF;
    IF action='reject' THEN
      d.status:='draft'; d.current_command_id:=NULL;
    ELSE
      INSERT INTO public.manual_journal_execution_permits VALUES(org,entity,draft,c.id,actor,action,pg_current_xact_id());
      IF action='approve' THEN
        IF EXISTS(SELECT 1 FROM public.journal_posting_decisions WHERE command_id=c.id AND actor_id=actor) THEN RAISE EXCEPTION 'ALREADY_APPROVED'; END IF;
        PERFORM app_security.approve_journal_posting_source(org,entity,draft,c.source_version,coalesce(btrim(reason),'Reviewed frozen journal submission'),request);
        IF app_security.manual_journal_approval_count(c.id)>=(c.threshold->>'numberOfDistinctApprovers')::integer THEN d.status:='approved'; ELSE d.status:='submitted'; END IF;
      ELSE
        IF d.status<>'approved' THEN RAISE EXCEPTION 'APPROVAL_REQUIRED'; END IF;
        IF app_security.manual_journal_approval_count(c.id)<(c.threshold->>'numberOfDistinctApprovers')::integer THEN RAISE EXCEPTION 'APPROVAL_REQUIRED'; END IF;
        ledger:=app_security.post_authorized_journal(org,entity,draft,c.source_version,key,request);
        d.journal_id:=(ledger->>'journalId')::uuid; d.status:='posted';
      END IF;
      DELETE FROM public.manual_journal_execution_permits WHERE organization_id=org AND legal_entity_id=entity AND draft_id=draft AND manual_journal_execution_permits.action=transition_manual_journal.action AND transaction_id=pg_current_xact_id();
    END IF;
  END IF;
  UPDATE public.manual_journal_drafts SET status=d.status,current_command_id=d.current_command_id,submission_count=d.submission_count,journal_id=d.journal_id,
    transition_reason=CASE WHEN reason IS NULL THEN NULL ELSE btrim(reason) END,version=version+1,updated_by=actor,updated_at=clock_timestamp() WHERE id=draft RETURNING * INTO d;
  INSERT INTO public.manual_journal_revisions(organization_id,legal_entity_id,draft_id,version,snapshot) VALUES(org,entity,draft,d.version,to_jsonb(d));
  INSERT INTO public.audit_events(id,organization_id,legal_entity_id,actor_id,action,target_id,request_id) VALUES(gen_random_uuid(),org,entity,actor,operation,draft,request);
  response:=jsonb_build_object('resourceId',draft,'version',d.version,'status',d.status,'requestId',request);
  IF d.journal_id IS NOT NULL THEN response:=response||jsonb_build_object('journalId',d.journal_id); END IF;
  INSERT INTO public.manual_journal_results VALUES(org,entity,actor,operation,key,command,draft,response);
  RETURN response;
END $$;

CREATE FUNCTION app_security.manual_journal_review(org uuid,entity uuid,draft uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.manual_journal_drafts; c public.journal_posting_sources; approvals jsonb;
BEGIN
  IF NOT app_security.finance_setup_scope(org,entity) OR NOT app_security.can_read_accounts(org) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  SELECT * INTO d FROM public.manual_journal_drafts WHERE organization_id=org AND legal_entity_id=entity AND id=draft;
  IF d.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF d.current_command_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO c FROM public.journal_posting_sources WHERE id=d.current_command_id AND organization_id=org AND legal_entity_id=entity;
  SELECT coalesce(jsonb_agg(jsonb_build_object('actorId',a.actor_id,'reason',a.reason,'createdAt',a.created_at,'eligible',app_security.journal_principal_eligible(org,entity,a.actor_id,true)) ORDER BY a.created_at,a.id),'[]') INTO approvals FROM public.journal_posting_decisions a WHERE a.command_id=c.id;
  RETURN jsonb_build_object('sourceVersion',c.source_version,'contentHash',c.content_hash,'policyId',c.policy_id,'policyVersion',c.policy_version,
    'requiredApprovals',(c.threshold->>'numberOfDistinctApprovers')::integer,'validApprovals',app_security.manual_journal_approval_count(c.id),
    'snapshotValid',d.status='posted' OR app_security.journal_source_dependencies_valid(c.id),
    'canApprove',app_security.journal_principal_eligible(org,entity,current_setting('app.user_id',true),true) AND NOT app_security.manual_journal_actor_is_author(org,entity,draft,current_setting('app.user_id',true))
      AND NOT EXISTS(SELECT 1 FROM public.journal_posting_decisions WHERE command_id=c.id AND actor_id=current_setting('app.user_id',true)), 'approvals',approvals);
END $$;
REVOKE ALL ON FUNCTION app_security.manual_journal_actor_is_author(uuid,uuid,uuid,text),app_security.manual_journal_approval_count(uuid),
  app_security.transition_manual_journal(uuid,uuid,uuid,integer,text,text,text,text,text),app_security.manual_journal_review(uuid,uuid,uuid) FROM PUBLIC;
 
CREATE OR REPLACE FUNCTION app_security.journal_source_dependencies_valid(command uuid) RETURNS boolean
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
  RETURN current_branches=c.branch_snapshots AND current_mapping IS NOT DISTINCT FROM c.mapping_revision_id
    AND (NOT EXISTS(SELECT 1 FROM public.manual_journal_drafts WHERE organization_id=c.organization_id AND legal_entity_id=c.legal_entity_id AND id=c.source_id)
      OR EXISTS(SELECT 1 FROM public.manual_journal_drafts WHERE organization_id=c.organization_id AND legal_entity_id=c.legal_entity_id AND id=c.source_id AND status IN ('submitted','approved') AND current_command_id=c.id AND body=c.body));
END $$;

CREATE OR REPLACE FUNCTION app_security.approve_journal_posting_source(org uuid,entity uuid,source uuid,revision integer,reason text,request text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.journal_posting_sources; previous public.journal_posting_decisions; actor text:=current_setting('app.user_id',true); decision uuid;
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  IF NOT app_security.finance_setup_scope(org,entity) OR NOT app_security.journal_principal_eligible(org,entity,actor,true) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF EXISTS(SELECT 1 FROM public.manual_journal_drafts WHERE organization_id=org AND legal_entity_id=entity AND id=source)
    AND NOT EXISTS(SELECT 1 FROM public.manual_journal_execution_permits WHERE organization_id=org AND legal_entity_id=entity AND draft_id=source AND principal_id=actor AND action='approve' AND transaction_id=pg_current_xact_id())
    THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
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

CREATE OR REPLACE FUNCTION app_security.post_authorized_journal(org uuid,entity uuid,source uuid,revision integer,key text,request text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.journal_posting_sources; prior public.journal_posting_results; consumed public.journal_source_postings;
  header public.journal_entries; response jsonb; actor text:=current_setting('app.user_id',true); period_id uuid;
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  IF NOT app_security.finance_setup_scope(org,entity) OR NOT app_security.journal_principal_eligible(org,entity,actor,true) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF source IS NULL OR revision IS NULL OR revision<1 OR key IS NULL OR key !~ '^[A-Za-z0-9_.-]{8,200}$' OR request IS NULL OR length(btrim(request)) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
  IF EXISTS(SELECT 1 FROM public.manual_journal_drafts WHERE organization_id=org AND legal_entity_id=entity AND id=source)
    AND NOT EXISTS(SELECT 1 FROM public.manual_journal_execution_permits WHERE organization_id=org AND legal_entity_id=entity AND draft_id=source AND principal_id=actor AND action='post' AND transaction_id=pg_current_xact_id())
    THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
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

CREATE OR REPLACE FUNCTION app_security.save_manual_journal_draft(org uuid,entity uuid,draft uuid,expected integer,input jsonb,key text,request text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.manual_journal_drafts; prior public.manual_journal_results; line jsonb; a public.accounts;
  normalized_lines jsonb:='[]'::jsonb; normalized jsonb; debit_sum numeric:=0; credit_sum numeric:=0; b uuid; actor text:=current_setting('app.user_id',true);
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  IF NOT app_security.finance_setup_scope(org,entity) OR NOT app_security.journal_principal_eligible(org,entity,actor,false) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF input IS NULL OR jsonb_typeof(input) IS DISTINCT FROM 'object' OR NOT input ?& ARRAY['postingDate','documentDate','description','lines']
    OR input-ARRAY['postingDate','documentDate','description','lines']<>'{}'::jsonb
    OR jsonb_typeof(input->'description') IS DISTINCT FROM 'string' OR length(btrim(input->>'description')) NOT BETWEEN 1 AND 1000
    OR jsonb_typeof(input->'postingDate') IS DISTINCT FROM 'string' OR input->>'postingDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR jsonb_typeof(input->'documentDate') IS DISTINCT FROM 'string' OR input->>'documentDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR jsonb_typeof(input->'lines') IS DISTINCT FROM 'array' OR request IS NULL OR length(btrim(request)) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
  PERFORM (input->>'postingDate')::date,(input->>'documentDate')::date;
  IF draft IS NULL THEN
    IF expected IS NOT NULL OR key IS NULL OR key !~ '^[A-Za-z0-9_.-]{8,200}$' THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
    SELECT * INTO prior FROM public.manual_journal_results WHERE organization_id=org AND legal_entity_id=entity AND principal_id=actor AND operation='journal.draft.create' AND manual_journal_results.key=save_manual_journal_draft.key;
    IF prior.draft_id IS NOT NULL THEN
      IF prior.request_body IS DISTINCT FROM input THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
      RETURN prior.result;
    END IF;
  ELSE
    SELECT * INTO d FROM public.manual_journal_drafts WHERE organization_id=org AND legal_entity_id=entity AND id=draft FOR UPDATE;
    IF d.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
    IF expected IS NULL OR expected<>d.version THEN RAISE EXCEPTION 'STALE_VERSION'; END IF;
    IF d.status NOT IN ('draft','submitted','approved') THEN RAISE EXCEPTION 'INVALID_STATE'; END IF;
  END IF;
  IF jsonb_array_length(input->'lines') NOT BETWEEN 2 AND 500 THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(input->'lines') LOOP
    IF jsonb_typeof(line) IS DISTINCT FROM 'object' OR NOT line ?& ARRAY['accountId','debit','credit','dimensions']
      OR line-ARRAY['accountId','debit','credit','dimensions']<>'{}'::jsonb
      OR jsonb_typeof(line->'debit') IS DISTINCT FROM 'string' OR jsonb_typeof(line->'credit') IS DISTINCT FROM 'string'
      OR line->>'debit' !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,2})?$' OR line->>'credit' !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,2})?$'
      OR NOT (((line->>'debit')::numeric>0 AND (line->>'credit')::numeric=0) OR ((line->>'credit')::numeric>0 AND (line->>'debit')::numeric=0))
      OR jsonb_typeof(line->'dimensions') IS DISTINCT FROM 'object' OR (line->'dimensions')-'branchId'<>'{}'::jsonb THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
    SELECT * INTO a FROM public.accounts WHERE organization_id=org AND legal_entity_id=entity AND id=(line->>'accountId')::uuid AND active;
    IF a.id IS NULL THEN RAISE EXCEPTION 'ACCOUNT_UNAVAILABLE'; END IF;
    IF a.is_control THEN RAISE EXCEPTION 'CONTROL_ACCOUNT_FORBIDDEN'; END IF;
    IF line->'dimensions' ? 'branchId' THEN
      b:=NULL;
      SELECT id INTO b FROM public.branches WHERE organization_id=org AND legal_entity_id=entity AND id=(line->'dimensions'->>'branchId')::uuid FOR SHARE;
      IF b IS NULL THEN RAISE EXCEPTION 'DIMENSION_UNAVAILABLE'; END IF;
    END IF;
    normalized_lines:=normalized_lines || jsonb_build_array(line || jsonb_build_object('accountVersion',a.version,'debit',((line->>'debit')::numeric(20,2))::text,'credit',((line->>'credit')::numeric(20,2))::text));
    debit_sum:=debit_sum+(line->>'debit')::numeric; credit_sum:=credit_sum+(line->>'credit')::numeric;
  END LOOP;
  IF debit_sum<>credit_sum OR debit_sum<=0 OR debit_sum>999999999999999999.99 THEN RAISE EXCEPTION 'UNBALANCED_JOURNAL'; END IF;
  normalized:=input || jsonb_build_object('lines',normalized_lines,'description',btrim(input->>'description'),'currency','NPR');
  IF draft IS NULL THEN
    INSERT INTO public.manual_journal_drafts(id,organization_id,legal_entity_id,body,amount,created_by,updated_by) VALUES(gen_random_uuid(),org,entity,normalized,debit_sum,actor,actor) RETURNING * INTO d;
  ELSE
    UPDATE public.manual_journal_drafts SET body=normalized,amount=debit_sum,status='draft',current_command_id=NULL,transition_reason=NULL,version=version+1,updated_by=actor,updated_at=clock_timestamp() WHERE id=draft RETURNING * INTO d;
  END IF;
  INSERT INTO public.manual_journal_revisions(organization_id,legal_entity_id,draft_id,version,snapshot) VALUES(org,entity,d.id,d.version,to_jsonb(d));
  INSERT INTO public.audit_events(id,organization_id,legal_entity_id,actor_id,action,target_id,request_id) VALUES(gen_random_uuid(),org,entity,actor,CASE WHEN draft IS NULL THEN 'journal.draft.create' ELSE 'journal.draft.update' END,d.id,request);
  IF draft IS NULL THEN INSERT INTO public.manual_journal_results VALUES(org,entity,actor,'journal.draft.create',key,input,d.id,to_jsonb(d)); END IF;
  RETURN to_jsonb(d);
END $$;

CREATE OR REPLACE FUNCTION app_security.cancel_manual_journal_draft(org uuid,entity uuid,draft uuid,expected integer,reason text,key text,request text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.manual_journal_drafts; prior public.manual_journal_results; command jsonb; response jsonb; actor text:=current_setting('app.user_id',true);
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  IF NOT app_security.finance_setup_scope(org,entity) OR NOT app_security.journal_principal_eligible(org,entity,actor,false) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF draft IS NULL OR expected IS NULL OR expected<1 OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 3 AND 1000 OR key IS NULL OR key !~ '^[A-Za-z0-9_.-]{8,200}$' OR request IS NULL OR length(btrim(request)) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
  command:=jsonb_build_object('id',draft,'version',expected,'reason',btrim(reason));
  SELECT * INTO prior FROM public.manual_journal_results WHERE organization_id=org AND legal_entity_id=entity AND principal_id=actor AND operation='journal.draft.cancel' AND manual_journal_results.key=cancel_manual_journal_draft.key;
  IF prior.draft_id IS NOT NULL THEN
    IF prior.request_body IS DISTINCT FROM command THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN prior.result;
  END IF;
  SELECT * INTO d FROM public.manual_journal_drafts WHERE organization_id=org AND legal_entity_id=entity AND id=draft FOR UPDATE;
  IF d.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF expected<>d.version THEN RAISE EXCEPTION 'STALE_VERSION'; END IF;
  IF d.status NOT IN ('draft','submitted','approved') THEN RAISE EXCEPTION 'INVALID_STATE'; END IF;
  UPDATE public.manual_journal_drafts SET status='cancelled',current_command_id=NULL,transition_reason=NULL,cancel_reason=btrim(reason),version=version+1,updated_by=actor,updated_at=clock_timestamp() WHERE id=draft RETURNING * INTO d;
  INSERT INTO public.manual_journal_revisions(organization_id,legal_entity_id,draft_id,version,snapshot) VALUES(org,entity,d.id,d.version,to_jsonb(d));
  INSERT INTO public.audit_events(id,organization_id,legal_entity_id,actor_id,action,target_id,request_id) VALUES(gen_random_uuid(),org,entity,actor,'journal.draft.cancel',d.id,request);
  response:=jsonb_build_object('resourceId',d.id,'version',d.version,'status','cancelled','requestId',request);
  INSERT INTO public.manual_journal_results VALUES(org,entity,actor,'journal.draft.cancel',key,command,d.id,response);
  RETURN response;
END $$;
