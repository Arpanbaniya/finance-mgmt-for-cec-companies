-- Drafts cannot allocate numbers, prepare approved sources, or write the ledger.
CREATE TABLE manual_journal_drafts (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL,
  body jsonb NOT NULL, amount numeric(20,2) NOT NULL CHECK(amount>0),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','cancelled')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_by text NOT NULL REFERENCES auth_user(id), updated_by text NOT NULL REFERENCES auth_user(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), cancel_reason text,
  UNIQUE(organization_id,legal_entity_id,id),
  FOREIGN KEY(organization_id,legal_entity_id) REFERENCES legal_entities(organization_id,id),
  CHECK((status='draft' AND cancel_reason IS NULL) OR (status='cancelled' AND length(btrim(cancel_reason)) BETWEEN 3 AND 1000))
);
CREATE TABLE manual_journal_revisions (
  organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL, draft_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0), snapshot jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,legal_entity_id,draft_id,version),
  FOREIGN KEY(organization_id,legal_entity_id,draft_id) REFERENCES manual_journal_drafts(organization_id,legal_entity_id,id)
);
CREATE TABLE manual_journal_results (
  organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL, principal_id text NOT NULL REFERENCES auth_user(id),
  operation text NOT NULL CHECK(operation IN ('journal.draft.create','journal.draft.cancel')),
  key text NOT NULL CHECK(key ~ '^[A-Za-z0-9_.-]{8,200}$'), request_body jsonb NOT NULL, draft_id uuid NOT NULL, result jsonb NOT NULL,
  PRIMARY KEY(organization_id,legal_entity_id,principal_id,operation,key),
  FOREIGN KEY(organization_id,legal_entity_id,draft_id) REFERENCES manual_journal_drafts(organization_id,legal_entity_id,id)
);
ALTER TABLE manual_journal_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_journal_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_journal_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY manual_draft_read ON manual_journal_drafts FOR SELECT USING(app_security.finance_setup_scope(organization_id,legal_entity_id) AND app_security.can_read_accounts(organization_id));
CREATE POLICY manual_revision_read ON manual_journal_revisions FOR SELECT USING(app_security.finance_setup_scope(organization_id,legal_entity_id) AND app_security.can_read_accounts(organization_id));
CREATE TRIGGER manual_draft_no_delete BEFORE DELETE ON manual_journal_drafts FOR EACH ROW EXECUTE FUNCTION app_security.append_only();
CREATE TRIGGER manual_revision_immutable BEFORE UPDATE OR DELETE ON manual_journal_revisions FOR EACH ROW EXECUTE FUNCTION app_security.append_only();
CREATE TRIGGER manual_result_immutable BEFORE UPDATE OR DELETE ON manual_journal_results FOR EACH ROW EXECUTE FUNCTION app_security.append_only();

CREATE FUNCTION app_security.save_manual_journal_draft(org uuid,entity uuid,draft uuid,expected integer,input jsonb,key text,request text) RETURNS jsonb
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
    IF d.status<>'draft' THEN RAISE EXCEPTION 'INVALID_STATE'; END IF;
  END IF;
  IF jsonb_array_length(input->'lines') NOT BETWEEN 2 AND 500 THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(input->'lines') LOOP
    IF jsonb_typeof(line) IS DISTINCT FROM 'object' OR NOT line ?& ARRAY['accountId','debit','credit','dimensions']
      OR line-ARRAY['accountId','debit','credit','dimensions']<>'{}'::jsonb
      OR jsonb_typeof(line->'debit') IS DISTINCT FROM 'string' OR jsonb_typeof(line->'credit') IS DISTINCT FROM 'string'
      OR line->>'debit' !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,2})?$' OR line->>'credit' !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,2})?$'
      OR NOT (((line->>'debit')::numeric>0 AND (line->>'credit')::numeric=0) OR ((line->>'credit')::numeric>0 AND (line->>'debit')::numeric=0))
      OR jsonb_typeof(line->'dimensions') IS DISTINCT FROM 'object' OR line->'dimensions'-'branchId'<>'{}'::jsonb THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
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
    UPDATE public.manual_journal_drafts SET body=normalized,amount=debit_sum,version=version+1,updated_by=actor,updated_at=clock_timestamp() WHERE id=draft RETURNING * INTO d;
  END IF;
  INSERT INTO public.manual_journal_revisions(organization_id,legal_entity_id,draft_id,version,snapshot) VALUES(org,entity,d.id,d.version,to_jsonb(d));
  INSERT INTO public.audit_events(id,organization_id,legal_entity_id,actor_id,action,target_id,request_id,changes) VALUES(gen_random_uuid(),org,entity,actor,CASE WHEN draft IS NULL THEN 'journal.draft.create' ELSE 'journal.draft.update' END,d.id,request,'{}');
  IF draft IS NULL THEN INSERT INTO public.manual_journal_results VALUES(org,entity,actor,'journal.draft.create',key,input,d.id,to_jsonb(d)); END IF;
  RETURN to_jsonb(d);
END $$;

CREATE FUNCTION app_security.cancel_manual_journal_draft(org uuid,entity uuid,draft uuid,expected integer,reason text,key text,request text) RETURNS jsonb
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
  IF d.status<>'draft' THEN RAISE EXCEPTION 'INVALID_STATE'; END IF;
  UPDATE public.manual_journal_drafts SET status='cancelled',cancel_reason=btrim(reason),version=version+1,updated_by=actor,updated_at=clock_timestamp() WHERE id=draft RETURNING * INTO d;
  INSERT INTO public.manual_journal_revisions(organization_id,legal_entity_id,draft_id,version,snapshot) VALUES(org,entity,d.id,d.version,to_jsonb(d));
  INSERT INTO public.audit_events(id,organization_id,legal_entity_id,actor_id,action,target_id,request_id,changes) VALUES(gen_random_uuid(),org,entity,actor,'journal.draft.cancel',d.id,request,'{}');
  response:=jsonb_build_object('resourceId',d.id,'version',d.version,'status','cancelled','requestId',request);
  INSERT INTO public.manual_journal_results VALUES(org,entity,actor,'journal.draft.cancel',key,command,d.id,response);
  RETURN response;
END $$;
REVOKE ALL ON FUNCTION app_security.save_manual_journal_draft(uuid,uuid,uuid,integer,jsonb,text,text),app_security.cancel_manual_journal_draft(uuid,uuid,uuid,integer,text,text,text) FROM PUBLIC;
