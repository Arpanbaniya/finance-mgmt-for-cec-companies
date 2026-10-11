-- Extend only the finite allocation inverse seam; manual reversal stays intact.
CREATE OR REPLACE FUNCTION app_security.record_manual_reversal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.manual_journal_reversal_requests;
BEGIN
  IF NEW.source_type<>'journal' THEN
    IF NEW.event_kind='reverse' AND NOT EXISTS(SELECT 1 FROM public.subledger_sources WHERE id=NEW.source_id AND organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id AND journal_id=NEW.id AND kind='allocation_reverse' AND created_transaction=pg_current_xact_id() AND body=NEW.payload) THEN RAISE EXCEPTION 'REVERSAL_SOURCE_UNSUPPORTED'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO r FROM public.manual_journal_reversal_requests WHERE organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id AND draft_id=NEW.source_id;
  IF r.draft_id IS NOT NULL THEN
    PERFORM app_security.validate_manual_reversal_body(NEW.organization_id,NEW.legal_entity_id,NEW.source_id,NEW.payload);
    IF NEW.event_kind<>'reverse' OR NEW.posting_date<>r.posting_date THEN RAISE EXCEPTION 'REVERSAL_CONTENT_LOCKED'; END IF;
    INSERT INTO public.manual_journal_reversals(organization_id,legal_entity_id,original_journal_id,reversal_draft_id,reversal_journal_id,created_by) VALUES(NEW.organization_id,NEW.legal_entity_id,r.original_journal_id,r.draft_id,NEW.id,NEW.created_by);
    INSERT INTO public.audit_events(id,organization_id,legal_entity_id,actor_id,action,target_id,request_id) VALUES(gen_random_uuid(),NEW.organization_id,NEW.legal_entity_id,NEW.created_by,'journal.reversed',r.original_draft_id,current_setting('app.journal_request_id',true));
  ELSIF NEW.event_kind='reverse' THEN RAISE EXCEPTION 'REVERSAL_SOURCE_UNSUPPORTED'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app_security.check_subledger_integrity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.accounts; c public.accounts; a public.subledger_allocations; target public.subledger_open_items; capacity public.subledger_settlements;
BEGIN
  IF NEW.body->>'kind' IS DISTINCT FROM NEW.kind OR NEW.body->>'postingDate' IS DISTINCT FROM NEW.posting_date::text OR NEW.body->>'documentDate' IS DISTINCT FROM NEW.document_date::text THEN RAISE EXCEPTION 'SUBLEDGER_LINK_MISMATCH'; END IF;
  SELECT * INTO STRICT d FROM public.accounts WHERE id=NEW.debit_account_id;
  SELECT * INTO STRICT c FROM public.accounts WHERE id=NEW.credit_account_id;
  IF (NEW.kind='ar_item' AND (d.control_type IS DISTINCT FROM 'ar' OR c.is_control OR c.type<>'revenue'))
    OR (NEW.kind='ap_item' AND (c.control_type IS DISTINCT FROM 'ap' OR d.is_control OR d.type<>'expense'))
    OR (NEW.kind='ar_deposit' AND (d.control_type IS DISTINCT FROM 'cash' OR c.control_type IS DISTINCT FROM 'customer_deposits'))
    OR (NEW.kind='ap_advance' AND (d.control_type IS DISTINCT FROM 'supplier_advances' OR c.control_type IS DISTINCT FROM 'cash'))
    OR (NEW.kind='ar_direct' AND (d.control_type IS DISTINCT FROM 'cash' OR c.control_type IS DISTINCT FROM 'ar'))
    OR (NEW.kind='ap_direct' AND (d.control_type IS DISTINCT FROM 'ap' OR c.control_type IS DISTINCT FROM 'cash')) THEN RAISE EXCEPTION 'SUBLEDGER_LINK_MISMATCH'; END IF;
  FOR a IN SELECT * FROM public.subledger_allocations WHERE source_id=NEW.id LOOP
    SELECT * INTO STRICT target FROM public.subledger_open_items WHERE id=a.open_item_id;
    SELECT * INTO STRICT capacity FROM public.subledger_settlements WHERE id=a.settlement_id;
    IF a.reversal_of IS NULL THEN
      IF NOT EXISTS(SELECT 1 FROM public.journal_lines WHERE journal_id=target.journal_id AND ordinal=target.ordinal AND account_id=CASE target.side WHEN 'ar' THEN NEW.credit_account_id ELSE NEW.debit_account_id END) THEN RAISE EXCEPTION 'SUBLEDGER_LINK_MISMATCH'; END IF;
      IF EXISTS(SELECT unnest(ARRAY[target.journal_id,capacity.journal_id,NEW.journal_id]) EXCEPT SELECT journal_id FROM public.journal_reversal_holds WHERE organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id AND dependency_type='allocation' AND dependency_id=a.id) THEN RAISE EXCEPTION 'SUBLEDGER_DEPENDENCY_MISSING'; END IF;
    ELSE
      IF EXISTS(SELECT journal_id FROM public.journal_reversal_holds WHERE organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id AND dependency_type='allocation' AND dependency_id=a.reversal_of
        EXCEPT SELECT journal_id FROM public.journal_reversal_hold_releases WHERE organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id AND dependency_type='allocation' AND dependency_id=a.reversal_of AND release_source_id=NEW.id) THEN RAISE EXCEPTION 'SUBLEDGER_DEPENDENCY_MISSING'; END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER subledger_integrity AFTER INSERT ON subledger_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_security.check_subledger_integrity();
CREATE FUNCTION app_security.guard_subledger_release() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.subledger_allocations a JOIN public.subledger_open_items t ON t.id=a.open_item_id JOIN public.subledger_settlements c ON c.id=a.settlement_id
    JOIN public.subledger_allocations r ON r.reversal_of=a.id AND r.source_id=NEW.release_source_id
    WHERE a.id=NEW.dependency_id AND a.organization_id=NEW.organization_id AND a.legal_entity_id=NEW.legal_entity_id
    AND NEW.journal_id IN (a.journal_id,t.journal_id,c.journal_id)) THEN RAISE EXCEPTION 'SUBLEDGER_LINK_MISMATCH'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subledger_release_evidence BEFORE INSERT ON journal_reversal_hold_releases FOR EACH ROW EXECUTE FUNCTION app_security.guard_subledger_release();
REVOKE ALL ON FUNCTION app_security.check_subledger_integrity(),app_security.guard_subledger_release() FROM PUBLIC;
