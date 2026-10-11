-- Private source adapter foundation. No web-runtime EXECUTE or DML grants.
ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_source_type_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_source_type CHECK(source_type IN ('journal','invoice','bill','settlement'));

-- Identity reservation only; the party master/terms workflow remains separate.
CREATE TABLE subledger_counterparties (
  organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL, id uuid NOT NULL,
  created_by text NOT NULL REFERENCES auth_user(id), PRIMARY KEY(organization_id,legal_entity_id,id),
  FOREIGN KEY(organization_id,legal_entity_id) REFERENCES legal_entities(organization_id,id)
);
CREATE TABLE subledger_sources (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL, party_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('ar_item','ap_item','ar_deposit','ap_advance','ar_direct','ap_direct','application','allocation_reverse')),
  journal_id uuid NOT NULL UNIQUE, body jsonb NOT NULL,
  amount numeric(20,2) NOT NULL CHECK(amount>0 AND amount<=999999999999999999.99),
  debit_account_id uuid NOT NULL, debit_version integer NOT NULL, credit_account_id uuid NOT NULL, credit_version integer NOT NULL,
  posting_date date NOT NULL CHECK(posting_date BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'),
  document_date date NOT NULL CHECK(document_date BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'),
  recorded_at timestamptz NOT NULL, created_transaction xid8 NOT NULL, created_by text NOT NULL REFERENCES auth_user(id),
  UNIQUE(organization_id,legal_entity_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,party_id) REFERENCES subledger_counterparties(organization_id,legal_entity_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,journal_id) REFERENCES journal_entries(organization_id,legal_entity_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(organization_id,legal_entity_id,debit_account_id,debit_version) REFERENCES account_versions(organization_id,legal_entity_id,account_id,version),
  FOREIGN KEY(organization_id,legal_entity_id,credit_account_id,credit_version) REFERENCES account_versions(organization_id,legal_entity_id,account_id,version)
);
CREATE TABLE subledger_open_items (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL, party_id uuid NOT NULL,
  side text NOT NULL CHECK(side IN ('ar','ap')), source_id uuid NOT NULL UNIQUE, journal_id uuid NOT NULL, ordinal integer NOT NULL,
  amount numeric(20,2) NOT NULL CHECK(amount>0 AND amount<=999999999999999999.99), due_date date NOT NULL CHECK(due_date BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'),
  posting_date date NOT NULL, recorded_at timestamptz NOT NULL,
  UNIQUE(organization_id,legal_entity_id,id), UNIQUE(journal_id,ordinal),
  FOREIGN KEY(organization_id,legal_entity_id,source_id) REFERENCES subledger_sources(organization_id,legal_entity_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,party_id) REFERENCES subledger_counterparties(organization_id,legal_entity_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,journal_id) REFERENCES journal_entries(organization_id,legal_entity_id,id),
  FOREIGN KEY(journal_id,ordinal) REFERENCES journal_lines(journal_id,ordinal)
);
CREATE TABLE subledger_settlements (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL, party_id uuid NOT NULL,
  side text NOT NULL CHECK(side IN ('ar','ap')), mode text NOT NULL CHECK(mode IN ('direct','on_account')),
  source_id uuid NOT NULL UNIQUE, journal_id uuid NOT NULL, ordinal integer NOT NULL,
  amount numeric(20,2) NOT NULL CHECK(amount>0 AND amount<=999999999999999999.99), posting_date date NOT NULL, recorded_at timestamptz NOT NULL,
  UNIQUE(organization_id,legal_entity_id,id), UNIQUE(journal_id,ordinal),
  FOREIGN KEY(organization_id,legal_entity_id,source_id) REFERENCES subledger_sources(organization_id,legal_entity_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,party_id) REFERENCES subledger_counterparties(organization_id,legal_entity_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,journal_id) REFERENCES journal_entries(organization_id,legal_entity_id,id),
  FOREIGN KEY(journal_id,ordinal) REFERENCES journal_lines(journal_id,ordinal)
);
CREATE TABLE subledger_allocations (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL, source_id uuid NOT NULL,
  settlement_id uuid NOT NULL, open_item_id uuid NOT NULL, amount numeric(20,2) NOT NULL CHECK(amount>0 AND amount<=999999999999999999.99),
  reversal_of uuid UNIQUE, effective_date date NOT NULL, recorded_at timestamptz NOT NULL, journal_id uuid NOT NULL,
  UNIQUE(organization_id,legal_entity_id,id), UNIQUE(source_id,open_item_id), CHECK(reversal_of IS NULL OR reversal_of<>id),
  FOREIGN KEY(organization_id,legal_entity_id,source_id) REFERENCES subledger_sources(organization_id,legal_entity_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,settlement_id) REFERENCES subledger_settlements(organization_id,legal_entity_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,open_item_id) REFERENCES subledger_open_items(organization_id,legal_entity_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,reversal_of) REFERENCES subledger_allocations(organization_id,legal_entity_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,journal_id) REFERENCES journal_entries(organization_id,legal_entity_id,id)
);
CREATE INDEX subledger_target_cutoff ON subledger_allocations(organization_id,legal_entity_id,open_item_id,effective_date,recorded_at);
CREATE INDEX subledger_settlement_cutoff ON subledger_allocations(organization_id,legal_entity_id,settlement_id,effective_date,recorded_at);
CREATE INDEX subledger_item_page ON subledger_open_items(organization_id,legal_entity_id,id);
CREATE TABLE subledger_events (
  source_id uuid PRIMARY KEY, organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL,
  journal_id uuid NOT NULL UNIQUE, kind text NOT NULL CHECK(kind='subledger.posted'), recorded_at timestamptz NOT NULL,
  FOREIGN KEY(organization_id,legal_entity_id,source_id) REFERENCES subledger_sources(organization_id,legal_entity_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,journal_id) REFERENCES journal_entries(organization_id,legal_entity_id,id)
);
CREATE TABLE journal_reversal_hold_releases (
  organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL, journal_id uuid NOT NULL,
  dependency_type text NOT NULL CHECK(dependency_type='allocation'), dependency_id uuid NOT NULL, release_source_id uuid NOT NULL,
  PRIMARY KEY(organization_id,legal_entity_id,journal_id,dependency_type,dependency_id),
  FOREIGN KEY(organization_id,legal_entity_id,journal_id,dependency_type,dependency_id) REFERENCES journal_reversal_holds(organization_id,legal_entity_id,journal_id,dependency_type,dependency_id),
  FOREIGN KEY(organization_id,legal_entity_id,release_source_id) REFERENCES subledger_sources(organization_id,legal_entity_id,id)
);

CREATE FUNCTION app_security.guard_subledger_record() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.subledger_sources; target public.subledger_open_items; capacity public.subledger_settlements; original public.subledger_allocations;
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
  IF NOT app_security.finance_setup_scope(NEW.organization_id,NEW.legal_entity_id) OR NOT app_security.can_manage_accounts(NEW.organization_id) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF TG_TABLE_NAME='subledger_counterparties' THEN
    IF NEW.created_by IS DISTINCT FROM current_setting('app.user_id',true) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF; RETURN NEW;
  ELSIF TG_TABLE_NAME='subledger_sources' THEN
    IF NEW.created_by IS DISTINCT FROM current_setting('app.user_id',true) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
    NEW.created_transaction:=pg_current_xact_id(); NEW.recorded_at:=clock_timestamp(); RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='journal_reversal_hold_releases' THEN
    SELECT * INTO s FROM public.subledger_sources WHERE id=NEW.release_source_id AND organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id;
    IF s.id IS NULL OR s.created_transaction<>pg_current_xact_id() OR s.kind<>'allocation_reverse' OR s.body->>'reversalOf'<>NEW.dependency_id::text THEN RAISE EXCEPTION 'SUBLEDGER_LINK_MISMATCH'; END IF; RETURN NEW;
  END IF;
  SELECT * INTO s FROM public.subledger_sources WHERE id=NEW.source_id AND organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id;
  IF s.id IS NULL OR s.created_transaction<>pg_current_xact_id() OR s.journal_id<>NEW.journal_id THEN RAISE EXCEPTION 'SUBLEDGER_LINK_MISMATCH'; END IF;
  NEW.recorded_at:=s.recorded_at;
  IF TG_TABLE_NAME='subledger_events' THEN RETURN NEW;
  ELSIF TG_TABLE_NAME='subledger_open_items' THEN
    IF s.kind<>NEW.side||'_item' OR NEW.party_id<>s.party_id OR NEW.amount<>s.amount OR NEW.ordinal<>(CASE WHEN NEW.side='ar' THEN 1 ELSE 2 END) OR NEW.due_date<>(s.body->>'dueDate')::date THEN RAISE EXCEPTION 'SUBLEDGER_LINK_MISMATCH'; END IF;
    NEW.posting_date:=s.posting_date; RETURN NEW;
  ELSIF TG_TABLE_NAME='subledger_settlements' THEN
    IF s.kind<>(CASE WHEN NEW.mode='direct' THEN NEW.side||'_direct' WHEN NEW.side='ar' THEN 'ar_deposit' ELSE 'ap_advance' END)
      OR NEW.id<>s.id OR NEW.party_id<>s.party_id OR NEW.amount<>s.amount OR NEW.ordinal<>(CASE WHEN NEW.side='ar' THEN 2 ELSE 1 END) THEN RAISE EXCEPTION 'SUBLEDGER_LINK_MISMATCH'; END IF;
    NEW.posting_date:=s.posting_date; RETURN NEW;
  END IF;
  SELECT * INTO target FROM public.subledger_open_items WHERE id=NEW.open_item_id AND organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id FOR UPDATE;
  SELECT * INTO capacity FROM public.subledger_settlements WHERE id=NEW.settlement_id AND organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id FOR UPDATE;
  IF target.id IS NULL OR capacity.id IS NULL OR target.party_id<>capacity.party_id OR target.party_id<>s.party_id OR target.side<>capacity.side THEN RAISE EXCEPTION 'SUBLEDGER_SCOPE_MISMATCH'; END IF;
  IF s.posting_date<target.posting_date OR s.posting_date<capacity.posting_date OR s.recorded_at<target.recorded_at OR s.recorded_at<capacity.recorded_at THEN RAISE EXCEPTION 'SUBLEDGER_DATE_MISMATCH'; END IF;
  IF NEW.reversal_of IS NULL THEN
    IF capacity.mode='direct' THEN
      IF s.id<>capacity.source_id OR s.created_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'SOURCE_ALREADY_CONSUMED'; END IF;
    ELSIF s.kind<>'application' OR NEW.amount<>s.amount OR s.body->>'settlementId'<>capacity.id::text OR s.body->>'openItemId'<>target.id::text THEN RAISE EXCEPTION 'SUBLEDGER_LINK_MISMATCH'; END IF;
  ELSE
    SELECT * INTO original FROM public.subledger_allocations WHERE id=NEW.reversal_of AND organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id;
    IF original.id IS NULL OR original.reversal_of IS NOT NULL OR s.kind<>'allocation_reverse' OR s.body->>'reversalOf'<>original.id::text
      OR (NEW.settlement_id,NEW.open_item_id,NEW.amount) IS DISTINCT FROM (original.settlement_id,original.open_item_id,original.amount) THEN RAISE EXCEPTION 'SUBLEDGER_LINK_MISMATCH'; END IF;
    IF s.posting_date<original.effective_date OR s.recorded_at<original.recorded_at THEN RAISE EXCEPTION 'SUBLEDGER_DATE_MISMATCH'; END IF;
    IF capacity.mode='direct' THEN RAISE EXCEPTION 'FEATURE_NOT_ENABLED'; END IF;
  END IF;
  NEW.effective_date:=s.posting_date; RETURN NEW;
END $$;

-- Preserve the existing authority, period, numbering and append cut-off guards.
CREATE OR REPLACE FUNCTION app_security.guard_journal_entry() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE receipt public.document_numbers; period_row public.fiscal_periods; s public.subledger_sources;
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
  IF NOT app_security.finance_setup_scope(NEW.organization_id,NEW.legal_entity_id) OR NOT app_security.can_manage_accounts(NEW.organization_id)
    OR NEW.created_by IS DISTINCT FROM current_setting('app.user_id',true)
    OR NOT EXISTS(SELECT 1 FROM public.legal_entities WHERE id=NEW.legal_entity_id AND organization_id=NEW.organization_id AND base_currency=NEW.currency AND policy_status='demo') THEN RAISE EXCEPTION 'Invalid internal journal authority or unsupported live policy'; END IF;
  SELECT * INTO period_row FROM public.fiscal_periods WHERE id=NEW.fiscal_period_id AND organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id FOR UPDATE;
  IF period_row.id IS NULL OR period_row.state<>'open' OR NEW.posting_date<period_row.start_date OR NEW.posting_date>=period_row.end_date_exclusive THEN RAISE EXCEPTION 'An open fiscal period is required'; END IF;
  SELECT * INTO receipt FROM public.document_numbers WHERE id=NEW.number_id;
  IF receipt.id IS NULL OR (receipt.organization_id,receipt.legal_entity_id,receipt.document_type,receipt.source_id,receipt.event_kind,receipt.posting_date,receipt.number,receipt.fiscal_year_id)
    IS DISTINCT FROM (NEW.organization_id,NEW.legal_entity_id,NEW.source_type,NEW.source_id,NEW.event_kind,NEW.posting_date,NEW.number,period_row.fiscal_year_id) THEN RAISE EXCEPTION 'Journal number does not match its source and fiscal scope'; END IF;
  NEW.created_transaction:=pg_current_xact_id(); NEW.created_at:=clock_timestamp();
  IF NEW.source_type<>'journal' THEN
    SELECT * INTO s FROM public.subledger_sources WHERE id=NEW.source_id AND organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id;
    IF s.id IS NULL OR s.created_transaction<>pg_current_xact_id() OR (s.journal_id,s.posting_date,s.document_date,s.amount,s.amount,s.body) IS DISTINCT FROM (NEW.id,NEW.posting_date,NEW.document_date,NEW.total_debit,NEW.total_credit,NEW.payload)
      OR NEW.source_type<>(CASE s.kind WHEN 'ar_item' THEN 'invoice' WHEN 'ap_item' THEN 'bill' ELSE 'settlement' END)
      OR NEW.event_kind<>(CASE s.kind WHEN 'allocation_reverse' THEN 'reverse' ELSE 'post' END) THEN RAISE EXCEPTION 'SUBLEDGER_LINK_MISMATCH'; END IF;
    NEW.created_at:=s.recorded_at;
  END IF; RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION app_security.guard_journal_line() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE header public.journal_entries; master public.accounts; s public.subledger_sources;
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
  SELECT * INTO header FROM public.journal_entries WHERE id=NEW.journal_id AND organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id;
  IF header.id IS NULL OR header.created_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Posted journal cannot acquire new lines'; END IF;
  SELECT * INTO master FROM public.accounts WHERE id=NEW.account_id AND organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id FOR UPDATE;
  IF header.source_type='journal' THEN
    IF master.id IS NULL OR NOT master.active OR master.is_control OR master.version<>NEW.account_version THEN RAISE EXCEPTION 'An active current ordinary account version is required'; END IF;
  ELSE
    SELECT * INTO s FROM public.subledger_sources WHERE id=header.source_id AND organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id;
    IF master.id IS NULL OR NOT master.active OR s.id IS NULL OR s.created_transaction<>pg_current_xact_id() OR NEW.branch_id IS NOT NULL
      OR (NEW.ordinal,NEW.account_id,NEW.account_version,NEW.debit,NEW.credit) IS DISTINCT FROM
      (NEW.ordinal,CASE NEW.ordinal WHEN 1 THEN s.debit_account_id WHEN 2 THEN s.credit_account_id END,CASE NEW.ordinal WHEN 1 THEN s.debit_version WHEN 2 THEN s.credit_version END,CASE NEW.ordinal WHEN 1 THEN s.amount ELSE 0::numeric END,CASE NEW.ordinal WHEN 2 THEN s.amount ELSE 0::numeric END)
      OR (s.kind<>'allocation_reverse' AND master.version<>NEW.account_version) THEN RAISE EXCEPTION 'SUBLEDGER_LINK_MISMATCH'; END IF;
  END IF;
  IF NEW.branch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.branches WHERE id=NEW.branch_id AND organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id) THEN RAISE EXCEPTION 'Branch is outside the journal company'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app_security.check_subledger_source() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.subledger_sources; n integer; capacity public.subledger_settlements; original public.subledger_allocations;
BEGIN
  SELECT * INTO STRICT s FROM public.subledger_sources WHERE id=NEW.id;
  IF (SELECT count(*) FROM public.journal_lines WHERE journal_id=s.journal_id)<>2 THEN RAISE EXCEPTION 'SUBLEDGER_LINK_MISMATCH'; END IF;
  IF s.kind IN ('ar_item','ap_item') THEN SELECT count(*) INTO n FROM public.subledger_open_items WHERE source_id=s.id;
  ELSIF s.kind IN ('ar_deposit','ap_advance','ar_direct','ap_direct') THEN
    SELECT count(*) INTO n FROM public.subledger_settlements WHERE source_id=s.id;
    IF s.kind IN ('ar_direct','ap_direct') AND (SELECT coalesce(sum(amount),0) FROM public.subledger_allocations WHERE source_id=s.id AND reversal_of IS NULL)<>s.amount THEN RAISE EXCEPTION 'DIRECT_SETTLEMENT_INCOMPLETE'; END IF;
  ELSE
    SELECT count(*) INTO n FROM public.subledger_allocations WHERE source_id=s.id;
    IF s.kind='application' THEN
      SELECT c.* INTO capacity FROM public.subledger_settlements c JOIN public.subledger_allocations a ON a.settlement_id=c.id WHERE a.source_id=s.id;
      IF NOT EXISTS(SELECT 1 FROM public.journal_lines l WHERE l.journal_id=capacity.journal_id AND l.ordinal=capacity.ordinal AND l.account_id=CASE capacity.side WHEN 'ar' THEN s.debit_account_id ELSE s.credit_account_id END) THEN RAISE EXCEPTION 'SUBLEDGER_LINK_MISMATCH'; END IF;
    ELSE
      SELECT a.* INTO original FROM public.subledger_allocations a JOIN public.subledger_allocations r ON r.reversal_of=a.id WHERE r.source_id=s.id;
      IF NOT EXISTS(SELECT 1 FROM public.subledger_sources o WHERE o.id=original.source_id AND (s.debit_account_id,s.debit_version,s.credit_account_id,s.credit_version)=(o.credit_account_id,o.credit_version,o.debit_account_id,o.debit_version)) THEN RAISE EXCEPTION 'SUBLEDGER_LINK_MISMATCH'; END IF;
    END IF;
  END IF;
  IF n<>1 OR NOT EXISTS(SELECT 1 FROM public.subledger_events WHERE source_id=s.id AND journal_id=s.journal_id AND recorded_at=s.recorded_at)
    OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE organization_id=s.organization_id AND legal_entity_id=s.legal_entity_id AND target_id=s.id AND actor_id=s.created_by AND action='subledger.internal_posted') THEN RAISE EXCEPTION 'SUBLEDGER_LINK_MISMATCH'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER subledger_source_complete AFTER INSERT ON subledger_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_security.check_subledger_source();

CREATE FUNCTION app_security.check_allocation_balances() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE capacity numeric; target_amount numeric;
BEGIN
  SELECT amount INTO capacity FROM public.subledger_settlements WHERE id=NEW.settlement_id;
  SELECT amount INTO target_amount FROM public.subledger_open_items WHERE id=NEW.open_item_id;
  -- Validate every date/knowledge rectangle, not only two independent prefixes.
  IF EXISTS(WITH e AS (SELECT effective_date,recorded_at,CASE WHEN reversal_of IS NULL THEN amount ELSE -amount END AS amount FROM public.subledger_allocations WHERE settlement_id=NEW.settlement_id),
    d AS (SELECT DISTINCT effective_date FROM e), k AS (SELECT DISTINCT recorded_at FROM e)
    SELECT 1 FROM d CROSS JOIN k JOIN e ON e.effective_date<=d.effective_date AND e.recorded_at<=k.recorded_at GROUP BY d.effective_date,k.recorded_at HAVING sum(e.amount)<0 OR sum(e.amount)>capacity)
    OR EXISTS(WITH e AS (SELECT effective_date,recorded_at,CASE WHEN reversal_of IS NULL THEN amount ELSE -amount END AS amount FROM public.subledger_allocations WHERE open_item_id=NEW.open_item_id),
    d AS (SELECT DISTINCT effective_date FROM e), k AS (SELECT DISTINCT recorded_at FROM e)
    SELECT 1 FROM d CROSS JOIN k JOIN e ON e.effective_date<=d.effective_date AND e.recorded_at<=k.recorded_at GROUP BY d.effective_date,k.recorded_at HAVING sum(e.amount)<0 OR sum(e.amount)>target_amount) THEN RAISE EXCEPTION 'OVER_ALLOCATION'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER allocation_balances AFTER INSERT ON subledger_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_security.check_allocation_balances();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['subledger_counterparties','subledger_sources','subledger_open_items','subledger_settlements','subledger_allocations','subledger_events','journal_reversal_hold_releases'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE TRIGGER subledger_guard BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION app_security.guard_subledger_record()',t);
    EXECUTE format('CREATE TRIGGER subledger_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_security.append_only()',t);
    IF t<>'journal_reversal_hold_releases' THEN EXECUTE format('CREATE POLICY subledger_read ON %I FOR SELECT USING(app_security.finance_setup_scope(organization_id,legal_entity_id) AND app_security.can_read_accounts(organization_id))',t); END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION app_security.guard_subledger_record(),app_security.check_subledger_source(),app_security.check_allocation_balances() FROM PUBLIC;
