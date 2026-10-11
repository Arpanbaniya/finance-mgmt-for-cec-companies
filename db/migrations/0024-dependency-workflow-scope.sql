-- Checking source dependencies is not a finance-posting authorization. Preserve
-- accountant draft editing; the calling transition still owns its action gate.
CREATE OR REPLACE FUNCTION app_security.require_journal_dependencies_clear(org uuid,entity uuid,journal uuid,posting date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  IF NOT app_security.finance_setup_scope(org,entity) OR NOT app_security.can_read_accounts(org) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF posting IS NULL OR posting NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.journal_entries WHERE id=journal AND organization_id=org AND legal_entity_id=entity) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF EXISTS(SELECT 1 FROM public.journal_reversal_holds h WHERE h.organization_id=org AND h.legal_entity_id=entity AND h.journal_id=journal
    AND NOT EXISTS(SELECT 1 FROM public.journal_reversal_hold_releases r JOIN public.subledger_sources s
      ON s.organization_id=r.organization_id AND s.legal_entity_id=r.legal_entity_id AND s.id=r.release_source_id
      WHERE (r.organization_id,r.legal_entity_id,r.journal_id,r.dependency_type,r.dependency_id)=(h.organization_id,h.legal_entity_id,h.journal_id,h.dependency_type,h.dependency_id)
      AND s.kind='allocation_reverse' AND s.posting_date<=posting)) THEN RAISE EXCEPTION 'REVERSAL_DEPENDENCY'; END IF;
END $$;
REVOKE ALL ON FUNCTION app_security.require_journal_dependencies_clear(uuid,uuid,uuid,date) FROM PUBLIC;
