-- Private common dependency gate, consumed only by controlled source workflows.
CREATE FUNCTION app_security.require_journal_dependencies_clear(org uuid,entity uuid,journal uuid,posting date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  IF NOT app_security.finance_setup_scope(org,entity) OR NOT app_security.can_manage_accounts(org) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF posting IS NULL OR posting NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.journal_entries WHERE id=journal AND organization_id=org AND legal_entity_id=entity) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF EXISTS(SELECT 1 FROM public.journal_reversal_holds h WHERE h.organization_id=org AND h.legal_entity_id=entity AND h.journal_id=journal
    AND NOT EXISTS(SELECT 1 FROM public.journal_reversal_hold_releases r JOIN public.subledger_sources s
      ON s.organization_id=r.organization_id AND s.legal_entity_id=r.legal_entity_id AND s.id=r.release_source_id
      WHERE (r.organization_id,r.legal_entity_id,r.journal_id,r.dependency_type,r.dependency_id)=(h.organization_id,h.legal_entity_id,h.journal_id,h.dependency_type,h.dependency_id)
      AND s.kind='allocation_reverse' AND s.posting_date<=posting)) THEN RAISE EXCEPTION 'REVERSAL_DEPENDENCY'; END IF;
END $$;

CREATE OR REPLACE FUNCTION app_security.require_manual_reversal_source(org uuid,entity uuid,original uuid) RETURNS public.journal_entries
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
  -- Availability check only. The locked body gate below checks the actual date.
  PERFORM app_security.require_journal_dependencies_clear(org,entity,j.id,DATE '9999-12-31');
  IF EXISTS(SELECT 1 FROM public.manual_journal_reversals WHERE original_journal_id=j.id) THEN RAISE EXCEPTION 'ALREADY_REVERSED'; END IF;
  RETURN j;
END $$;
CREATE OR REPLACE FUNCTION app_security.validate_manual_reversal_body(org uuid,entity uuid,draft uuid,body jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.manual_journal_reversal_requests; original public.journal_entries; expected_lines jsonb; supplied_lines jsonb;
BEGIN
  SELECT * INTO r FROM public.manual_journal_reversal_requests WHERE organization_id=org AND legal_entity_id=entity AND draft_id=validate_manual_reversal_body.draft;
  IF r.draft_id IS NULL THEN RETURN; END IF;
  SELECT * INTO original FROM app_security.require_manual_reversal_source(org,entity,r.original_draft_id);
  PERFORM app_security.require_journal_dependencies_clear(org,entity,original.id,r.posting_date);
  SELECT jsonb_agg((l-'accountVersion')||jsonb_build_object('debit',l->>'credit','credit',l->>'debit') ORDER BY n) INTO expected_lines FROM jsonb_array_elements(original.payload->'lines') WITH ORDINALITY a(l,n);
  SELECT jsonb_agg(l-'accountVersion' ORDER BY n) INTO supplied_lines FROM jsonb_array_elements(body->'lines') WITH ORDINALITY a(l,n);
  IF expected_lines IS DISTINCT FROM supplied_lines OR body->>'postingDate'<>r.posting_date::text OR body->>'documentDate'<>r.posting_date::text OR r.posting_date<original.posting_date THEN RAISE EXCEPTION 'REVERSAL_CONTENT_LOCKED'; END IF;
END $$;

CREATE FUNCTION app_security.check_subledger_inverse_dependencies() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE original public.subledger_allocations;
BEGIN
  SELECT * INTO STRICT original FROM public.subledger_allocations WHERE id=(NEW.body->>'reversalOf')::uuid AND organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id;
  -- At commit, this inverse must have released its own allocation holds. Other
  -- payment/reconciliation/close consumers remain blockers, including late ones.
  PERFORM app_security.require_journal_dependencies_clear(NEW.organization_id,NEW.legal_entity_id,original.journal_id,NEW.posting_date);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER subledger_inverse_dependencies AFTER INSERT ON subledger_sources
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.kind='allocation_reverse') EXECUTE FUNCTION app_security.check_subledger_inverse_dependencies();

CREATE OR REPLACE FUNCTION app_security.guard_reversal_hold() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.manual_journal_reversals WHERE original_journal_id=NEW.journal_id)
    OR EXISTS(SELECT 1 FROM public.subledger_allocations a JOIN public.subledger_allocations r ON r.reversal_of=a.id
      WHERE a.organization_id=NEW.organization_id AND a.legal_entity_id=NEW.legal_entity_id AND a.journal_id=NEW.journal_id) THEN RAISE EXCEPTION 'ALREADY_REVERSED'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_security.require_journal_dependencies_clear(uuid,uuid,uuid,date),app_security.check_subledger_inverse_dependencies() FROM PUBLIC;
