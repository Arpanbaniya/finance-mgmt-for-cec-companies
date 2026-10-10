-- A reversal is a fresh independently approved source, never a posted-head edit.
ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_event_kind_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_event_kind CHECK(event_kind IN ('post','reverse'));
ALTER TABLE manual_journal_results DROP CONSTRAINT manual_journal_result_operation;
ALTER TABLE manual_journal_results ADD CONSTRAINT manual_journal_result_operation CHECK(operation IN ('journal.draft.create','journal.draft.cancel','journal.submit','journal.approve','journal.reject','journal.post','journal.reverse'));

CREATE TABLE manual_journal_reversal_requests (
  organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL, draft_id uuid PRIMARY KEY,
  original_draft_id uuid NOT NULL, original_journal_id uuid NOT NULL,
  posting_date date NOT NULL, reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 1000),
  created_by text NOT NULL REFERENCES auth_user(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,legal_entity_id,draft_id), CHECK(draft_id<>original_draft_id),
  FOREIGN KEY(organization_id,legal_entity_id,draft_id) REFERENCES manual_journal_drafts(organization_id,legal_entity_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,original_draft_id) REFERENCES manual_journal_drafts(organization_id,legal_entity_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,original_journal_id) REFERENCES journal_entries(organization_id,legal_entity_id,id)
);
CREATE INDEX manual_reversal_original ON manual_journal_reversal_requests(organization_id,legal_entity_id,original_draft_id);
CREATE TABLE manual_journal_reversals (
  organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL, original_journal_id uuid PRIMARY KEY,
  reversal_draft_id uuid NOT NULL UNIQUE, reversal_journal_id uuid NOT NULL UNIQUE,
  created_by text NOT NULL REFERENCES auth_user(id), created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(original_journal_id<>reversal_journal_id),
  FOREIGN KEY(organization_id,legal_entity_id,original_journal_id) REFERENCES journal_entries(organization_id,legal_entity_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,reversal_draft_id) REFERENCES manual_journal_reversal_requests(organization_id,legal_entity_id,draft_id),
  FOREIGN KEY(organization_id,legal_entity_id,reversal_journal_id) REFERENCES journal_entries(organization_id,legal_entity_id,id)
);
-- Private dependency seam: later controlled financial/close adapters must bind
-- their consumed source here before shipping. No generic runtime hold API.
CREATE TABLE journal_reversal_holds (
  organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL, journal_id uuid NOT NULL,
  dependency_type text NOT NULL CHECK(dependency_type IN ('allocation','payment','reconciliation','opening','close')),
  dependency_id uuid NOT NULL, reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 1000),
  PRIMARY KEY(organization_id,legal_entity_id,journal_id,dependency_type,dependency_id),
  FOREIGN KEY(organization_id,legal_entity_id,journal_id) REFERENCES journal_entries(organization_id,legal_entity_id,id)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['manual_journal_reversal_requests','manual_journal_reversals','journal_reversal_holds'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE TRIGGER reversal_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_security.append_only()',t);
  END LOOP;
END $$;
CREATE POLICY reversal_request_read ON manual_journal_reversal_requests FOR SELECT USING(app_security.finance_setup_scope(organization_id,legal_entity_id) AND app_security.can_read_accounts(organization_id));
CREATE POLICY reversal_link_read ON manual_journal_reversals FOR SELECT USING(app_security.finance_setup_scope(organization_id,legal_entity_id) AND app_security.can_read_accounts(organization_id));

CREATE FUNCTION app_security.require_manual_reversal_source(org uuid,entity uuid,original uuid) RETURNS public.journal_entries
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.manual_journal_drafts; j public.journal_entries;
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  SELECT * INTO d FROM public.manual_journal_drafts WHERE organization_id=org AND legal_entity_id=entity AND id=original;
  IF d.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF d.status<>'posted' THEN RAISE EXCEPTION 'INVALID_STATE'; END IF;
  SELECT * INTO j FROM public.journal_entries WHERE organization_id=org AND legal_entity_id=entity AND id=d.journal_id;
  IF j.id IS NULL OR j.source_type<>'journal' OR j.source_id<>d.id OR j.event_kind<>'post' OR j.payload IS DISTINCT FROM d.body
    OR EXISTS(SELECT 1 FROM public.manual_journal_reversal_requests WHERE draft_id=original)
    OR EXISTS(SELECT 1 FROM public.journal_lines l JOIN public.accounts a ON a.organization_id=l.organization_id AND a.legal_entity_id=l.legal_entity_id AND a.id=l.account_id WHERE l.journal_id=j.id AND a.is_control)
    THEN RAISE EXCEPTION 'REVERSAL_SOURCE_UNSUPPORTED'; END IF;
  IF EXISTS(SELECT 1 FROM public.journal_reversal_holds WHERE organization_id=org AND legal_entity_id=entity AND journal_id=j.id) THEN RAISE EXCEPTION 'REVERSAL_DEPENDENCY'; END IF;
  IF EXISTS(SELECT 1 FROM public.manual_journal_reversals WHERE original_journal_id=j.id) THEN RAISE EXCEPTION 'ALREADY_REVERSED'; END IF;
  RETURN j;
END $$;

CREATE FUNCTION app_security.validate_manual_reversal_body(org uuid,entity uuid,draft uuid,body jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.manual_journal_reversal_requests; original public.journal_entries; expected_lines jsonb; supplied_lines jsonb;
BEGIN
  SELECT * INTO r FROM public.manual_journal_reversal_requests WHERE organization_id=org AND legal_entity_id=entity AND draft_id=validate_manual_reversal_body.draft;
  IF r.draft_id IS NULL THEN RETURN; END IF;
  SELECT * INTO original FROM app_security.require_manual_reversal_source(org,entity,r.original_draft_id);
  SELECT jsonb_agg((l-'accountVersion')||jsonb_build_object('debit',l->>'credit','credit',l->>'debit') ORDER BY n) INTO expected_lines FROM jsonb_array_elements(original.payload->'lines') WITH ORDINALITY a(l,n);
  SELECT jsonb_agg(l-'accountVersion' ORDER BY n) INTO supplied_lines FROM jsonb_array_elements(body->'lines') WITH ORDINALITY a(l,n);
  IF expected_lines IS DISTINCT FROM supplied_lines OR body->>'postingDate'<>r.posting_date::text OR body->>'documentDate'<>r.posting_date::text OR r.posting_date<original.posting_date THEN RAISE EXCEPTION 'REVERSAL_CONTENT_LOCKED'; END IF;
END $$;
CREATE FUNCTION app_security.guard_manual_reversal_edit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  -- Cancellation retains the request while releasing its unposted reservation.
  IF NEW.body IS DISTINCT FROM OLD.body THEN PERFORM app_security.validate_manual_reversal_body(NEW.organization_id,NEW.legal_entity_id,NEW.id,NEW.body); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER manual_reversal_content BEFORE UPDATE ON manual_journal_drafts FOR EACH ROW EXECUTE FUNCTION app_security.guard_manual_reversal_edit();

CREATE FUNCTION app_security.request_manual_journal_reversal(org uuid,entity uuid,original uuid,expected integer,posting date,reason text,key text,request text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.manual_journal_drafts; j public.journal_entries; prior public.manual_journal_results; command jsonb; input jsonb; inverse_lines jsonb; saved jsonb; response jsonb; actor text:=current_setting('app.user_id',true);
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  IF NOT app_security.finance_setup_scope(org,entity) OR NOT app_security.journal_principal_eligible(org,entity,actor,true) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF original IS NULL OR expected IS NULL OR expected<1 OR posting IS NULL OR posting NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'
    OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 3 AND 1000 OR key IS NULL OR key !~ '^[A-Za-z0-9_.-]{8,200}$' OR request IS NULL OR length(btrim(request)) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
  command:=jsonb_build_object('id',original,'version',expected,'postingDate',posting::text,'reason',btrim(reason));
  SELECT * INTO prior FROM public.manual_journal_results r WHERE r.organization_id=org AND r.legal_entity_id=entity AND r.principal_id=actor AND r.operation='journal.reverse' AND r.key=request_manual_journal_reversal.key;
  IF prior.draft_id IS NOT NULL THEN
    IF prior.request_body IS DISTINCT FROM command THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN prior.result;
  END IF;
  SELECT * INTO d FROM public.manual_journal_drafts WHERE organization_id=org AND legal_entity_id=entity AND id=original;
  IF d.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF d.version<>expected THEN RAISE EXCEPTION 'STALE_VERSION'; END IF;
  SELECT * INTO j FROM app_security.require_manual_reversal_source(org,entity,original);
  IF posting<j.posting_date THEN RAISE EXCEPTION 'REVERSAL_DATE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.fiscal_periods WHERE organization_id=org AND legal_entity_id=entity AND start_date<=posting AND posting<end_date_exclusive AND state='open') THEN RAISE EXCEPTION 'PERIOD_CLOSED'; END IF;
  IF EXISTS(SELECT 1 FROM public.manual_journal_reversal_requests r JOIN public.manual_journal_drafts child ON child.id=r.draft_id WHERE r.organization_id=org AND r.legal_entity_id=entity AND r.original_draft_id=original AND child.status<>'cancelled') THEN RAISE EXCEPTION 'REVERSAL_PENDING'; END IF;
  SELECT jsonb_agg((l-'accountVersion')||jsonb_build_object('debit',l->>'credit','credit',l->>'debit') ORDER BY n) INTO inverse_lines FROM jsonb_array_elements(j.payload->'lines') WITH ORDINALITY a(l,n);
  input:=jsonb_build_object('postingDate',posting::text,'documentDate',posting::text,'description',left('Reversal of '||j.number||': '||btrim(reason),1000),'lines',inverse_lines);
  -- A separate internal create namespace avoids reusing the caller's ordinary draft key.
  saved:=app_security.save_manual_journal_draft(org,entity,NULL,NULL,input,gen_random_uuid()::text,request);
  INSERT INTO public.manual_journal_reversal_requests(organization_id,legal_entity_id,draft_id,original_draft_id,original_journal_id,posting_date,reason,created_by) VALUES(org,entity,(saved->>'id')::uuid,original,j.id,posting,btrim(reason),actor);
  response:=jsonb_build_object('resourceId',saved->>'id','version',1,'status','draft','requestId',request);
  INSERT INTO public.manual_journal_results VALUES(org,entity,actor,'journal.reverse',key,command,(saved->>'id')::uuid,response);
  INSERT INTO public.audit_events(id,organization_id,legal_entity_id,actor_id,action,target_id,request_id) VALUES(gen_random_uuid(),org,entity,actor,'journal.reverse_requested',original,request);
  RETURN response;
END $$;

CREATE FUNCTION app_security.guard_reversal_hold() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.manual_journal_reversals WHERE original_journal_id=NEW.journal_id) THEN RAISE EXCEPTION 'ALREADY_REVERSED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reversal_hold_scope_lock BEFORE INSERT ON journal_reversal_holds FOR EACH ROW EXECUTE FUNCTION app_security.guard_reversal_hold();
CREATE FUNCTION app_security.record_manual_reversal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.manual_journal_reversal_requests;
BEGIN
  SELECT * INTO r FROM public.manual_journal_reversal_requests WHERE organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id AND draft_id=NEW.source_id;
  IF r.draft_id IS NOT NULL THEN
    PERFORM app_security.validate_manual_reversal_body(NEW.organization_id,NEW.legal_entity_id,NEW.source_id,NEW.payload);
    IF NEW.event_kind<>'reverse' OR NEW.posting_date<>r.posting_date THEN RAISE EXCEPTION 'REVERSAL_CONTENT_LOCKED'; END IF;
    INSERT INTO public.manual_journal_reversals(organization_id,legal_entity_id,original_journal_id,reversal_draft_id,reversal_journal_id,created_by) VALUES(NEW.organization_id,NEW.legal_entity_id,r.original_journal_id,r.draft_id,NEW.id,NEW.created_by);
    INSERT INTO public.audit_events(id,organization_id,legal_entity_id,actor_id,action,target_id,request_id) VALUES(gen_random_uuid(),NEW.organization_id,NEW.legal_entity_id,NEW.created_by,'journal.reversed',r.original_draft_id,current_setting('app.journal_request_id',true));
  ELSIF NEW.event_kind='reverse' THEN RAISE EXCEPTION 'REVERSAL_SOURCE_UNSUPPORTED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER manual_reversal_link AFTER INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION app_security.record_manual_reversal();
REVOKE ALL ON manual_journal_reversal_requests,manual_journal_reversals,journal_reversal_holds FROM PUBLIC;
REVOKE ALL ON FUNCTION app_security.require_manual_reversal_source(uuid,uuid,uuid),app_security.validate_manual_reversal_body(uuid,uuid,uuid,jsonb),app_security.guard_manual_reversal_edit(),
  app_security.request_manual_journal_reversal(uuid,uuid,uuid,integer,date,text,text,text),app_security.guard_reversal_hold(),app_security.record_manual_reversal() FROM PUBLIC;
CREATE OR REPLACE FUNCTION app_security.write_manual_journal(org uuid,entity uuid,source uuid,body jsonb,request text) RETURNS public.journal_entries
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE header public.journal_entries; receipt public.document_numbers; period_row public.fiscal_periods;
  line jsonb; posting date; document date; debit_sum numeric:=0; credit_sum numeric:=0; position integer:=0; kind text:='post';
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  IF NOT app_security.finance_setup_scope(org,entity) OR NOT app_security.can_manage_accounts(org) THEN RAISE EXCEPTION 'Invalid internal journal authority'; END IF;
  IF source IS NULL OR request IS NULL OR length(btrim(request)) NOT BETWEEN 1 AND 200 OR jsonb_typeof(body) IS DISTINCT FROM 'object'
    OR NOT body ?& ARRAY['postingDate','documentDate','description','currency','lines']
    OR body-ARRAY['postingDate','documentDate','description','currency','lines']<>'{}'::jsonb
    OR jsonb_typeof(body->'postingDate') IS DISTINCT FROM 'string' OR jsonb_typeof(body->'documentDate') IS DISTINCT FROM 'string'
    OR (body->>'postingDate') !~ '^\d{4}-\d{2}-\d{2}$' OR (body->>'documentDate') !~ '^\d{4}-\d{2}-\d{2}$'
    OR jsonb_typeof(body->'description') IS DISTINCT FROM 'string' OR length(btrim(body->>'description')) NOT BETWEEN 1 AND 1000
    OR body->>'currency' IS DISTINCT FROM 'NPR' OR jsonb_typeof(body->'lines') IS DISTINCT FROM 'array'
    THEN RAISE EXCEPTION 'Invalid manual journal payload'; END IF;
  IF jsonb_array_length(body->'lines') NOT BETWEEN 2 AND 500 THEN RAISE EXCEPTION 'Journal requires two to five hundred lines'; END IF;
  IF EXISTS(SELECT 1 FROM public.manual_journal_reversal_requests WHERE organization_id=org AND legal_entity_id=entity AND draft_id=source) THEN
    PERFORM app_security.validate_manual_reversal_body(org,entity,source,body); kind:='reverse';
    PERFORM set_config('app.journal_request_id',request,true);
  END IF;
  posting:=(body->>'postingDate')::date; document:=(body->>'documentDate')::date;
  IF posting NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' OR document NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' THEN RAISE EXCEPTION 'Unsupported journal date'; END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(body->'lines') LOOP
    IF jsonb_typeof(line) IS DISTINCT FROM 'object' OR NOT line ?& ARRAY['accountId','accountVersion','debit','credit','dimensions']
      OR line-ARRAY['accountId','accountVersion','debit','credit','dimensions']<>'{}'::jsonb
      OR jsonb_typeof(line->'accountId') IS DISTINCT FROM 'string' OR jsonb_typeof(line->'accountVersion') IS DISTINCT FROM 'number'
      OR (line->>'accountVersion') !~ '^[1-9][0-9]*$' OR (line->>'accountVersion')::numeric>2147483647
      OR jsonb_typeof(line->'debit') IS DISTINCT FROM 'string' OR jsonb_typeof(line->'credit') IS DISTINCT FROM 'string'
      OR (line->>'debit') !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,2})?$' OR (line->>'credit') !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,2})?$'
      OR jsonb_typeof(line->'dimensions') IS DISTINCT FROM 'object' OR (line->'dimensions')-'branchId'<>'{}'::jsonb
      OR ((line->'dimensions') ? 'branchId' AND jsonb_typeof(line->'dimensions'->'branchId') IS DISTINCT FROM 'string')
      THEN RAISE EXCEPTION 'Invalid manual journal line or unsupported dimension'; END IF;
    IF NOT (((line->>'debit')::numeric>0 AND (line->>'credit')::numeric=0) OR ((line->>'credit')::numeric>0 AND (line->>'debit')::numeric=0))
      THEN RAISE EXCEPTION 'Journal line requires exactly one positive side'; END IF;
    debit_sum:=debit_sum+(line->>'debit')::numeric; credit_sum:=credit_sum+(line->>'credit')::numeric;
  END LOOP;
  IF debit_sum<>credit_sum OR debit_sum>999999999999999999.99 THEN RAISE EXCEPTION 'Journal must balance exactly within money bounds'; END IF;
  SELECT * INTO header FROM public.journal_entries WHERE organization_id=org AND legal_entity_id=entity AND source_type='journal' AND source_id=source AND event_kind=kind;
  IF header.id IS NOT NULL THEN
    IF header.payload IS DISTINCT FROM body THEN RAISE EXCEPTION 'Source already posted with different content'; END IF;
    RETURN header;
  END IF;
  SELECT * INTO period_row FROM public.fiscal_periods WHERE organization_id=org AND legal_entity_id=entity AND start_date<=posting AND posting<end_date_exclusive FOR UPDATE;
  IF period_row.id IS NULL OR period_row.state<>'open' THEN RAISE EXCEPTION 'An open fiscal period is required'; END IF;
  -- Stable order shared with account/membership/period mutations.
  PERFORM 1 FROM public.accounts WHERE organization_id=org AND legal_entity_id=entity AND id IN (SELECT (value->>'accountId')::uuid FROM jsonb_array_elements(body->'lines')) ORDER BY id FOR UPDATE;
  SELECT * INTO receipt FROM app_security.allocate_document_number(org,entity,'journal',source,kind,posting);
  INSERT INTO public.journal_entries(id,organization_id,legal_entity_id,source_type,source_id,event_kind,status,posting_date,document_date,description,currency,number_id,number,fiscal_period_id,payload,total_debit,total_credit,created_by)
    VALUES(gen_random_uuid(),org,entity,'journal',source,kind,'posted',posting,document,btrim(body->>'description'),'NPR',receipt.id,receipt.number,period_row.id,body,debit_sum,credit_sum,current_setting('app.user_id',true)) RETURNING * INTO header;
  FOR line IN SELECT value FROM jsonb_array_elements(body->'lines') LOOP
    position:=position+1;
    INSERT INTO public.journal_lines(organization_id,legal_entity_id,journal_id,ordinal,account_id,account_version,debit,credit,branch_id)
      VALUES(org,entity,header.id,position,(line->>'accountId')::uuid,(line->>'accountVersion')::integer,(line->>'debit')::numeric,(line->>'credit')::numeric,(line->'dimensions'->>'branchId')::uuid);
  END LOOP;
  INSERT INTO public.audit_events(id,organization_id,legal_entity_id,actor_id,action,target_id,request_id)
    VALUES(gen_random_uuid(),org,entity,current_setting('app.user_id',true),'journal.internal_posted',header.id,request);
  RETURN header;
END $$;
