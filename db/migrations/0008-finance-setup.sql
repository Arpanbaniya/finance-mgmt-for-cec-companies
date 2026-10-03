CREATE TABLE fiscal_years (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL,
  label text NOT NULL CHECK(length(btrim(label)) BETWEEN 1 AND 100), start_date date NOT NULL, end_date_exclusive date NOT NULL,
  period_count integer NOT NULL CHECK(period_count BETWEEN 1 AND 24), retained_earnings_account_id uuid NOT NULL, retained_earnings_account_version integer NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version=1), created_by text NOT NULL REFERENCES auth_user(id), created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(start_date>=DATE '1900-01-01' AND end_date_exclusive<=DATE '9999-12-31' AND start_date<end_date_exclusive),
  UNIQUE(organization_id,legal_entity_id,id),
  FOREIGN KEY(organization_id,legal_entity_id) REFERENCES legal_entities(organization_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,retained_earnings_account_id,retained_earnings_account_version) REFERENCES account_versions(organization_id,legal_entity_id,account_id,version)
);
CREATE UNIQUE INDEX fiscal_year_label ON fiscal_years(organization_id,legal_entity_id,lower(btrim(label)));
CREATE TABLE fiscal_periods (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL, fiscal_year_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 24), start_date date NOT NULL, end_date_exclusive date NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','soft_closed','hard_closed')), version integer NOT NULL DEFAULT 1 CHECK(version>0),
  closed_at timestamptz, close_snapshot_id uuid, created_by text NOT NULL REFERENCES auth_user(id), created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(start_date<end_date_exclusive), UNIQUE(organization_id,legal_entity_id,id), UNIQUE(fiscal_year_id,ordinal),
  FOREIGN KEY(organization_id,legal_entity_id,fiscal_year_id) REFERENCES fiscal_years(organization_id,legal_entity_id,id)
);
CREATE INDEX fiscal_period_dates ON fiscal_periods(organization_id,legal_entity_id,start_date,end_date_exclusive);
CREATE FUNCTION app_security.finance_setup_scope(org uuid,entity uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT coalesce(org::text=current_setting('app.org_id',true) AND entity::text=current_setting('app.entity_id',true) AND app_security.can_entity(org,entity),false)
$$;
CREATE FUNCTION app_security.guard_fiscal_year() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
  IF NOT app_security.finance_setup_scope(NEW.organization_id,NEW.legal_entity_id) OR NOT app_security.can_manage_accounts(NEW.organization_id)
    OR NEW.created_by IS DISTINCT FROM current_setting('app.user_id',true) THEN RAISE EXCEPTION 'Invalid calendar authority'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.accounts WHERE organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id AND id=NEW.retained_earnings_account_id
    AND version=NEW.retained_earnings_account_version AND active AND type='equity' AND NOT is_control) THEN RAISE EXCEPTION 'Invalid retained earnings account'; END IF;
  IF EXISTS(SELECT 1 FROM public.fiscal_years WHERE organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id
    AND start_date<NEW.end_date_exclusive AND NEW.start_date<end_date_exclusive) THEN RAISE EXCEPTION 'Overlapping fiscal calendar'; END IF;
  NEW.created_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER fiscal_year_guard BEFORE INSERT ON fiscal_years FOR EACH ROW EXECUTE FUNCTION app_security.guard_fiscal_year();
CREATE TRIGGER fiscal_year_immutable BEFORE UPDATE OR DELETE ON fiscal_years FOR EACH ROW EXECUTE FUNCTION app_security.append_only();
CREATE FUNCTION app_security.guard_fiscal_period() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
  IF NOT app_security.finance_setup_scope(NEW.organization_id,NEW.legal_entity_id) OR NOT app_security.can_manage_accounts(NEW.organization_id)
    OR NEW.created_by IS DISTINCT FROM current_setting('app.user_id',true) OR NEW.state<>'open' OR NEW.version<>1 OR NEW.closed_at IS NOT NULL OR NEW.close_snapshot_id IS NOT NULL
    THEN RAISE EXCEPTION 'Invalid period creation'; END IF;
  NEW.created_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER fiscal_period_guard BEFORE INSERT ON fiscal_periods FOR EACH ROW EXECUTE FUNCTION app_security.guard_fiscal_period();
CREATE TRIGGER fiscal_period_immutable BEFORE UPDATE OR DELETE ON fiscal_periods FOR EACH ROW EXECUTE FUNCTION app_security.append_only();
CREATE FUNCTION app_security.check_fiscal_periods() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE year_row public.fiscal_years; year_id uuid;
BEGIN
  IF TG_TABLE_NAME='fiscal_years' THEN year_id:=NEW.id; ELSE year_id:=NEW.fiscal_year_id; END IF;
  SELECT * INTO STRICT year_row FROM public.fiscal_years WHERE id=year_id;
  IF (SELECT count(*) FROM public.fiscal_periods WHERE fiscal_year_id=year_id)<>year_row.period_count
    OR EXISTS(SELECT 1 FROM (
      SELECT ordinal,start_date,end_date_exclusive,lag(end_date_exclusive) OVER(ORDER BY ordinal) AS previous_end FROM public.fiscal_periods WHERE fiscal_year_id=year_id
    ) p WHERE (ordinal=1 AND start_date<>year_row.start_date) OR (ordinal>1 AND start_date IS DISTINCT FROM previous_end)
      OR ordinal>year_row.period_count OR (ordinal=year_row.period_count AND end_date_exclusive<>year_row.end_date_exclusive))
    THEN RAISE EXCEPTION 'Fiscal periods must completely and contiguously cover their year'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER fiscal_year_complete AFTER INSERT ON fiscal_years DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_security.check_fiscal_periods();
CREATE CONSTRAINT TRIGGER fiscal_period_complete AFTER INSERT ON fiscal_periods DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_security.check_fiscal_periods();

CREATE TABLE account_purposes(purpose text PRIMARY KEY, account_type text NOT NULL, control_type text);
INSERT INTO account_purposes VALUES
('ar','asset','ar'),('ap','liability','ap'),('cash','asset','cash'),('service_revenue','revenue',NULL),('expense','expense',NULL),
('input_tax','asset','tax_receivable'),('output_tax','liability','tax_payable'),('withholding_receivable','asset','tax_receivable'),('withholding_payable','liability','tax_payable'),
('customer_deposits','liability','customer_deposits'),('supplier_advances','asset','supplier_advances'),('worker_advances','asset','worker_advances'),
('wages_expense','expense',NULL),('employer_contribution_expense','expense',NULL),('wages_payable','liability','wages_payable'),('statutory_payable','liability','statutory_payable'),
('payroll_tax_payable','liability','tax_payable'),('staff_advances','asset','staff_advances'),('employee_reimbursements','liability','employee_reimbursements'),('bank_charges','expense',NULL),
('suspense_asset','asset',NULL),('suspense_liability','liability',NULL),('accrued_liability','liability',NULL),('prepaid_asset','asset',NULL),('retained_earnings','equity',NULL),('rounding','expense',NULL);
CREATE TABLE account_mapping_revisions (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL, version integer NOT NULL CHECK(version>=2), effective_from date NOT NULL,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 1000), created_by text NOT NULL REFERENCES auth_user(id), created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(effective_from>=DATE '1900-01-01' AND effective_from<=DATE '9999-12-31'),
  UNIQUE(organization_id,legal_entity_id,id), UNIQUE(organization_id,legal_entity_id,version), UNIQUE(organization_id,legal_entity_id,effective_from),
  FOREIGN KEY(organization_id,legal_entity_id) REFERENCES legal_entities(organization_id,id)
);
CREATE TABLE account_mapping_entries (
  organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL, revision_id uuid NOT NULL, purpose text NOT NULL REFERENCES account_purposes(purpose),
  account_id uuid NOT NULL, account_version integer NOT NULL,
  PRIMARY KEY(organization_id,legal_entity_id,revision_id,purpose),
  FOREIGN KEY(organization_id,legal_entity_id,revision_id) REFERENCES account_mapping_revisions(organization_id,legal_entity_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,account_id,account_version) REFERENCES account_versions(organization_id,legal_entity_id,account_id,version)
);
CREATE FUNCTION app_security.guard_mapping_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE previous public.account_mapping_revisions;
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
  IF NOT app_security.finance_setup_scope(NEW.organization_id,NEW.legal_entity_id) OR NOT app_security.can_manage_accounts(NEW.organization_id)
    OR NEW.created_by IS DISTINCT FROM current_setting('app.user_id',true) THEN RAISE EXCEPTION 'Invalid mapping authority'; END IF;
  SELECT * INTO previous FROM public.account_mapping_revisions WHERE organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id ORDER BY version DESC LIMIT 1;
  IF NEW.version<>coalesce(previous.version,1)+1 OR (previous.id IS NOT NULL AND (NEW.effective_from<=previous.effective_from OR NEW.effective_from<(clock_timestamp() AT TIME ZONE 'Asia/Kathmandu')::date))
    THEN RAISE EXCEPTION 'Mapping version or effective date conflict'; END IF;
  NEW.created_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER mapping_revision_guard BEFORE INSERT ON account_mapping_revisions FOR EACH ROW EXECUTE FUNCTION app_security.guard_mapping_revision();
CREATE FUNCTION app_security.guard_mapping_entry() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
  IF NOT app_security.finance_setup_scope(NEW.organization_id,NEW.legal_entity_id) OR NOT app_security.can_manage_accounts(NEW.organization_id)
    OR NOT EXISTS(SELECT 1 FROM public.accounts a JOIN public.account_purposes p ON p.purpose=NEW.purpose WHERE a.organization_id=NEW.organization_id AND a.legal_entity_id=NEW.legal_entity_id
      AND a.id=NEW.account_id AND a.version=NEW.account_version AND a.active AND a.type=p.account_type AND a.control_type IS NOT DISTINCT FROM p.control_type)
    THEN RAISE EXCEPTION 'Invalid account purpose or scope'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mapping_entry_guard BEFORE INSERT ON account_mapping_entries FOR EACH ROW EXECUTE FUNCTION app_security.guard_mapping_entry();
CREATE TRIGGER mapping_revision_immutable BEFORE UPDATE OR DELETE ON account_mapping_revisions FOR EACH ROW EXECUTE FUNCTION app_security.append_only();
CREATE TRIGGER mapping_entry_immutable BEFORE UPDATE OR DELETE ON account_mapping_entries FOR EACH ROW EXECUTE FUNCTION app_security.append_only();
CREATE FUNCTION app_security.check_mapping_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF (SELECT count(*) FROM public.account_mapping_entries WHERE revision_id=NEW.id)<>(SELECT count(*) FROM public.account_purposes) THEN RAISE EXCEPTION 'Incomplete account-purpose mapping'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER mapping_revision_complete AFTER INSERT ON account_mapping_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_security.check_mapping_complete();
CREATE FUNCTION app_security.guard_account_setup_dependencies() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.active AND NOT NEW.active AND (
    EXISTS(SELECT 1 FROM public.fiscal_years WHERE organization_id=OLD.organization_id AND legal_entity_id=OLD.legal_entity_id AND retained_earnings_account_id=OLD.id)
    OR EXISTS(SELECT 1 FROM public.account_mapping_entries e JOIN public.account_mapping_revisions r ON r.id=e.revision_id
      WHERE e.organization_id=OLD.organization_id AND e.legal_entity_id=OLD.legal_entity_id AND e.account_id=OLD.id
      AND (r.effective_from>=(clock_timestamp() AT TIME ZONE 'Asia/Kathmandu')::date OR r.id=(SELECT id FROM public.account_mapping_revisions
        WHERE organization_id=OLD.organization_id AND legal_entity_id=OLD.legal_entity_id AND effective_from<=(clock_timestamp() AT TIME ZONE 'Asia/Kathmandu')::date ORDER BY effective_from DESC LIMIT 1)))
  ) THEN RAISE EXCEPTION 'Account is required by a fiscal year or current/future mapping'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_setup_dependencies BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION app_security.guard_account_setup_dependencies();

CREATE TABLE document_series (
  organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL, fiscal_year_id uuid NOT NULL, document_type text NOT NULL,
  next_number bigint NOT NULL DEFAULT 1 CHECK(next_number BETWEEN 1 AND 999999999999),
  CHECK(document_type IN ('journal','invoice','bill','credit_note','settlement','transfer','expense','payroll_run','opening_batch','year_close','worker_advance')),
  PRIMARY KEY(organization_id,legal_entity_id,fiscal_year_id,document_type),
  FOREIGN KEY(organization_id,legal_entity_id,fiscal_year_id) REFERENCES fiscal_years(organization_id,legal_entity_id,id)
);
CREATE TABLE document_numbers (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL, fiscal_year_id uuid NOT NULL, document_type text NOT NULL,
  source_id uuid NOT NULL, event_kind text NOT NULL CHECK(event_kind IN ('post','reverse','opening','year_close')), posting_date date NOT NULL,
  sequence_number bigint NOT NULL CHECK(sequence_number>0), number text NOT NULL, created_by text NOT NULL REFERENCES auth_user(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,legal_entity_id,document_type,source_id,event_kind), UNIQUE(organization_id,legal_entity_id,number),
  FOREIGN KEY(organization_id,legal_entity_id,fiscal_year_id,document_type) REFERENCES document_series(organization_id,legal_entity_id,fiscal_year_id,document_type)
);
CREATE TRIGGER document_number_immutable BEFORE UPDATE OR DELETE ON document_numbers FOR EACH ROW EXECUTE FUNCTION app_security.append_only();
CREATE TRIGGER document_series_no_delete BEFORE DELETE ON document_series FOR EACH ROW EXECUTE FUNCTION app_security.append_only();
CREATE FUNCTION app_security.create_document_series() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  INSERT INTO public.document_series(organization_id,legal_entity_id,fiscal_year_id,document_type)
    SELECT NEW.organization_id,NEW.legal_entity_id,NEW.id,t FROM unnest(ARRAY['journal','invoice','bill','credit_note','settlement','transfer','expense','payroll_run','opening_batch','year_close','worker_advance']) t;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_year_series AFTER INSERT ON fiscal_years FOR EACH ROW EXECUTE FUNCTION app_security.create_document_series();
CREATE FUNCTION app_security.allocate_document_number(org uuid,entity uuid,kind text,source uuid,event text,posting date) RETURNS public.document_numbers
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE receipt public.document_numbers; period_row public.fiscal_periods; year_start date; next_value bigint;
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  IF NOT app_security.finance_setup_scope(org,entity) OR NOT app_security.can_manage_accounts(org) THEN RAISE EXCEPTION 'Invalid numbering authority'; END IF;
  SELECT * INTO receipt FROM public.document_numbers WHERE organization_id=org AND legal_entity_id=entity AND document_type=kind AND source_id=source AND event_kind=event;
  IF receipt.id IS NOT NULL THEN
    IF receipt.posting_date IS DISTINCT FROM posting THEN RAISE EXCEPTION 'Number source already bound to another posting date'; END IF;
    RETURN receipt;
  END IF;
  SELECT * INTO period_row FROM public.fiscal_periods WHERE organization_id=org AND legal_entity_id=entity AND start_date<=posting AND posting<end_date_exclusive FOR UPDATE;
  IF period_row.id IS NULL OR period_row.state<>'open' THEN RAISE EXCEPTION 'An open fiscal period is required'; END IF;
  SELECT next_number INTO next_value FROM public.document_series WHERE organization_id=org AND legal_entity_id=entity AND fiscal_year_id=period_row.fiscal_year_id AND document_type=kind FOR UPDATE;
  IF next_value IS NULL OR next_value>=999999999999 THEN RAISE EXCEPTION 'Document series unavailable or exhausted'; END IF;
  SELECT start_date INTO STRICT year_start FROM public.fiscal_years WHERE id=period_row.fiscal_year_id;
  INSERT INTO public.document_numbers(id,organization_id,legal_entity_id,fiscal_year_id,document_type,source_id,event_kind,posting_date,sequence_number,number,created_by)
    VALUES(gen_random_uuid(),org,entity,period_row.fiscal_year_id,kind,source,event,posting,next_value,
      upper(kind)||'-'||to_char(year_start,'YYYYMMDD')||'-'||lpad(next_value::text,greatest(6,length(next_value::text)),'0'),current_setting('app.user_id',true)) RETURNING * INTO receipt;
  UPDATE public.document_series SET next_number=next_number+1 WHERE organization_id=org AND legal_entity_id=entity AND fiscal_year_id=period_row.fiscal_year_id AND document_type=kind;
  RETURN receipt;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['fiscal_years','fiscal_periods','account_mapping_revisions','account_mapping_entries','document_series','document_numbers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY scoped_read ON %I FOR SELECT USING (app_security.finance_setup_scope(organization_id,legal_entity_id) AND app_security.can_read_accounts(organization_id))',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['fiscal_years','fiscal_periods','account_mapping_revisions','account_mapping_entries'] LOOP
    EXECUTE format('CREATE POLICY scoped_insert ON %I FOR INSERT WITH CHECK (app_security.finance_setup_scope(organization_id,legal_entity_id) AND app_security.can_manage_accounts(organization_id))',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['account_mapping_revisions','account_mapping_entries'] LOOP
    EXECUTE format('CREATE POLICY admin_mapping_read ON %I FOR SELECT USING (app_security.finance_setup_scope(organization_id,legal_entity_id) AND app_security.is_admin(organization_id))',t);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION app_security.finance_setup_scope(uuid,uuid),app_security.guard_fiscal_year(),app_security.guard_fiscal_period(),app_security.check_fiscal_periods(),
  app_security.guard_mapping_revision(),app_security.guard_mapping_entry(),app_security.check_mapping_complete(),app_security.guard_account_setup_dependencies(),app_security.create_document_series(),app_security.allocate_document_number(uuid,uuid,text,uuid,text,date) FROM PUBLIC;
