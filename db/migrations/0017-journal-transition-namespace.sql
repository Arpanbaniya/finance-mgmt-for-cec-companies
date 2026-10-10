-- Forward repair: keep the command namespace distinct from receipt columns.
CREATE OR REPLACE FUNCTION app_security.transition_manual_journal(org uuid,entity uuid,draft uuid,expected integer,action text,reason text,key text,canonical text,request text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.manual_journal_drafts; c public.journal_posting_sources; prior public.manual_journal_results;
  command jsonb; response jsonb; ledger jsonb; actor text:=current_setting('app.user_id',true); command_operation text:='journal.'||action;
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  IF NOT app_security.finance_setup_scope(org,entity) OR action IS NULL OR action NOT IN ('submit','approve','reject','post')
    OR NOT app_security.journal_principal_eligible(org,entity,actor,action<>'submit') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF draft IS NULL OR expected IS NULL OR expected<1 OR key IS NULL OR key !~ '^[A-Za-z0-9_.-]{8,200}$' OR request IS NULL OR length(btrim(request)) NOT BETWEEN 1 AND 200
    OR (reason IS NOT NULL AND length(btrim(reason)) NOT BETWEEN 3 AND 1000) OR (action='reject' AND reason IS NULL)
    OR (action<>'submit' AND canonical IS NOT NULL) OR (action='post' AND reason IS NOT NULL) THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
  command:=jsonb_build_object('id',draft,'version',expected,'reason',CASE WHEN reason IS NULL THEN NULL ELSE btrim(reason) END);
  SELECT * INTO prior FROM public.manual_journal_results r WHERE r.organization_id=org AND r.legal_entity_id=entity AND r.principal_id=actor AND r.operation=command_operation AND r.key=transition_manual_journal.key;
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
    INSERT INTO public.manual_journal_results VALUES(org,entity,actor,command_operation,key,command,draft,response);
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
  INSERT INTO public.audit_events(id,organization_id,legal_entity_id,actor_id,action,target_id,request_id) VALUES(gen_random_uuid(),org,entity,actor,command_operation,draft,request);
  response:=jsonb_build_object('resourceId',draft,'version',d.version,'status',d.status,'requestId',request);
  IF d.journal_id IS NOT NULL THEN response:=response||jsonb_build_object('journalId',d.journal_id); END IF;
  INSERT INTO public.manual_journal_results VALUES(org,entity,actor,command_operation,key,command,draft,response);
  RETURN response;
END $$;
