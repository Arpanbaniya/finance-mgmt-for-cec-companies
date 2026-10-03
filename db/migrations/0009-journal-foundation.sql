-- Internal manual-journal foundation. No application EXECUTE/INSERT grants.
-- Persisted approvals/source adapters must precede enabling runtime posting.
CREATE TABLE journal_entries (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL,
  source_type text NOT NULL CHECK(source_type='journal'), source_id uuid NOT NULL,
  event_kind text NOT NULL CHECK(event_kind='post'), status text NOT NULL CHECK(status='posted'),
  posting_date date NOT NULL CHECK(posting_date BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'),
  document_date date NOT NULL CHECK(document_date BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'),
  description text NOT NULL CHECK(length(btrim(description)) BETWEEN 1 AND 1000), currency text NOT NULL CHECK(currency='NPR'),
  number_id uuid NOT NULL UNIQUE REFERENCES document_numbers(id), number text NOT NULL,
  fiscal_period_id uuid NOT NULL, payload jsonb NOT NULL,
  total_debit numeric(20,2) NOT NULL CHECK(total_debit>0 AND total_debit<='999999999999999999.99'::numeric),
  total_credit numeric(20,2) NOT NULL CHECK(total_credit=total_debit),
  created_by text NOT NULL REFERENCES auth_user(id), created_at timestamptz NOT NULL DEFAULT now(),
  created_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
  UNIQUE(organization_id,legal_entity_id,id), UNIQUE(organization_id,legal_entity_id,source_type,source_id,event_kind),
  UNIQUE(organization_id,legal_entity_id,number),
  FOREIGN KEY(organization_id,legal_entity_id) REFERENCES legal_entities(organization_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,fiscal_period_id) REFERENCES fiscal_periods(organization_id,legal_entity_id,id)
);
CREATE TABLE journal_lines (
  organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL, journal_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 500), account_id uuid NOT NULL, account_version integer NOT NULL,
  debit numeric(20,2) NOT NULL CHECK(debit>=0 AND debit<='999999999999999999.99'::numeric),
  credit numeric(20,2) NOT NULL CHECK(credit>=0 AND credit<='999999999999999999.99'::numeric),
  branch_id uuid, PRIMARY KEY(journal_id,ordinal), CHECK((debit>0 AND credit=0) OR (credit>0 AND debit=0)),
  FOREIGN KEY(organization_id,legal_entity_id,journal_id) REFERENCES journal_entries(organization_id,legal_entity_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,account_id,account_version) REFERENCES account_versions(organization_id,legal_entity_id,account_id,version)
);
CREATE INDEX journal_account_references ON journal_lines(organization_id,legal_entity_id,account_id);
CREATE INDEX journal_posting_dates ON journal_entries(organization_id,legal_entity_id,posting_date,id);

CREATE FUNCTION app_security.guard_journal_entry() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE receipt public.document_numbers; period_row public.fiscal_periods;
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
  IF NOT app_security.finance_setup_scope(NEW.organization_id,NEW.legal_entity_id) OR NOT app_security.can_manage_accounts(NEW.organization_id)
    OR NEW.created_by IS DISTINCT FROM current_setting('app.user_id',true)
    OR NOT EXISTS(SELECT 1 FROM public.legal_entities WHERE id=NEW.legal_entity_id AND organization_id=NEW.organization_id AND base_currency=NEW.currency AND policy_status='demo')
    THEN RAISE EXCEPTION 'Invalid internal journal authority or unsupported live policy'; END IF;
  SELECT * INTO period_row FROM public.fiscal_periods WHERE id=NEW.fiscal_period_id AND organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id FOR UPDATE;
  IF period_row.id IS NULL OR period_row.state<>'open' OR NEW.posting_date<period_row.start_date OR NEW.posting_date>=period_row.end_date_exclusive
    THEN RAISE EXCEPTION 'An open fiscal period is required'; END IF;
  SELECT * INTO receipt FROM public.document_numbers WHERE id=NEW.number_id;
  IF receipt.id IS NULL OR (receipt.organization_id,receipt.legal_entity_id,receipt.document_type,receipt.source_id,receipt.event_kind,receipt.posting_date,receipt.number,receipt.fiscal_year_id)
    IS DISTINCT FROM (NEW.organization_id,NEW.legal_entity_id,NEW.source_type,NEW.source_id,NEW.event_kind,NEW.posting_date,NEW.number,period_row.fiscal_year_id)
    THEN RAISE EXCEPTION 'Journal number does not match its source and fiscal scope'; END IF;
  NEW.created_transaction:=pg_current_xact_id(); NEW.created_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER journal_entry_guard BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION app_security.guard_journal_entry();

CREATE FUNCTION app_security.guard_journal_line() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE header public.journal_entries; master public.accounts;
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
  SELECT * INTO header FROM public.journal_entries WHERE id=NEW.journal_id AND organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id;
  IF header.id IS NULL OR header.created_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Posted journal cannot acquire new lines'; END IF;
  SELECT * INTO master FROM public.accounts WHERE id=NEW.account_id AND organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id FOR UPDATE;
  IF master.id IS NULL OR NOT master.active OR master.is_control OR master.version<>NEW.account_version
    THEN RAISE EXCEPTION 'An active current ordinary account version is required'; END IF;
  IF NEW.branch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.branches WHERE id=NEW.branch_id AND organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id)
    THEN RAISE EXCEPTION 'Branch is outside the journal company'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_line_guard BEFORE INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION app_security.guard_journal_line();
CREATE TRIGGER journal_entry_immutable BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION app_security.append_only();
CREATE TRIGGER journal_line_immutable BEFORE UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION app_security.append_only();

CREATE FUNCTION app_security.check_journal_balance() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE header public.journal_entries; journal uuid; line_count integer; debit_sum numeric; credit_sum numeric;
BEGIN
  IF TG_TABLE_NAME='journal_entries' THEN journal:=NEW.id; ELSE journal:=NEW.journal_id; END IF;
  SELECT * INTO STRICT header FROM public.journal_entries WHERE id=journal;
  SELECT count(*),coalesce(sum(debit),0),coalesce(sum(credit),0) INTO line_count,debit_sum,credit_sum FROM public.journal_lines WHERE journal_id=journal;
  IF line_count NOT BETWEEN 2 AND 500 OR debit_sum<>credit_sum OR debit_sum<>header.total_debit OR credit_sum<>header.total_credit
    OR (SELECT max(ordinal) FROM public.journal_lines WHERE journal_id=journal)<>line_count
    THEN RAISE EXCEPTION 'Journal requires contiguous lines and exact debit/credit balance'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_entry_balance AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_security.check_journal_balance();
CREATE CONSTRAINT TRIGGER journal_line_balance AFTER INSERT ON journal_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_security.check_journal_balance();

CREATE FUNCTION app_security.guard_account_journal_dependencies() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.active AND NOT NEW.active AND EXISTS(SELECT 1 FROM public.journal_lines WHERE organization_id=OLD.organization_id AND legal_entity_id=OLD.legal_entity_id AND account_id=OLD.id)
    THEN RAISE EXCEPTION 'Account is referenced by posted journal history'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_journal_dependencies BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION app_security.guard_account_journal_dependencies();

CREATE FUNCTION app_security.write_manual_journal(org uuid,entity uuid,source uuid,body jsonb,request text) RETURNS public.journal_entries
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE header public.journal_entries; receipt public.document_numbers; period_row public.fiscal_periods;
  line jsonb; posting date; document date; debit_sum numeric:=0; credit_sum numeric:=0; position integer:=0;
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
  SELECT * INTO header FROM public.journal_entries WHERE organization_id=org AND legal_entity_id=entity AND source_type='journal' AND source_id=source AND event_kind='post';
  IF header.id IS NOT NULL THEN
    IF header.payload IS DISTINCT FROM body THEN RAISE EXCEPTION 'Source already posted with different content'; END IF;
    RETURN header;
  END IF;
  SELECT * INTO period_row FROM public.fiscal_periods WHERE organization_id=org AND legal_entity_id=entity AND start_date<=posting AND posting<end_date_exclusive FOR UPDATE;
  IF period_row.id IS NULL OR period_row.state<>'open' THEN RAISE EXCEPTION 'An open fiscal period is required'; END IF;
  -- Stable order shared with account/membership/period mutations.
  PERFORM 1 FROM public.accounts WHERE organization_id=org AND legal_entity_id=entity AND id IN (SELECT (value->>'accountId')::uuid FROM jsonb_array_elements(body->'lines')) ORDER BY id FOR UPDATE;
  SELECT * INTO receipt FROM app_security.allocate_document_number(org,entity,'journal',source,'post',posting);
  INSERT INTO public.journal_entries(id,organization_id,legal_entity_id,source_type,source_id,event_kind,status,posting_date,document_date,description,currency,number_id,number,fiscal_period_id,payload,total_debit,total_credit,created_by)
    VALUES(gen_random_uuid(),org,entity,'journal',source,'post','posted',posting,document,btrim(body->>'description'),'NPR',receipt.id,receipt.number,period_row.id,body,debit_sum,credit_sum,current_setting('app.user_id',true)) RETURNING * INTO header;
  FOR line IN SELECT value FROM jsonb_array_elements(body->'lines') LOOP
    position:=position+1;
    INSERT INTO public.journal_lines(organization_id,legal_entity_id,journal_id,ordinal,account_id,account_version,debit,credit,branch_id)
      VALUES(org,entity,header.id,position,(line->>'accountId')::uuid,(line->>'accountVersion')::integer,(line->>'debit')::numeric,(line->>'credit')::numeric,(line->'dimensions'->>'branchId')::uuid);
  END LOOP;
  INSERT INTO public.audit_events(id,organization_id,legal_entity_id,actor_id,action,target_id,request_id)
    VALUES(gen_random_uuid(),org,entity,current_setting('app.user_id',true),'journal.internal_posted',header.id,request);
  RETURN header;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['journal_entries','journal_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY journal_scoped_read ON %I FOR SELECT USING (app_security.finance_setup_scope(organization_id,legal_entity_id) AND app_security.can_read_accounts(organization_id))',t);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION app_security.guard_journal_entry(),app_security.guard_journal_line(),app_security.check_journal_balance(),
  app_security.guard_account_journal_dependencies(),app_security.write_manual_journal(uuid,uuid,uuid,jsonb,text) FROM PUBLIC;
