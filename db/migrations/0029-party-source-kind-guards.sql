-- Explicit NULL credit semantics and finite source kinds; LIKE underscores are wildcards.
ALTER TABLE parties DROP CONSTRAINT parties_check;
ALTER TABLE parties ADD CONSTRAINT party_customer_credit CHECK(credit_limit IS NULL OR (credit_limit>=0 AND role_set ? 'customer'));

CREATE OR REPLACE FUNCTION app_security.guard_party() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
  IF NOT app_security.finance_setup_scope(NEW.organization_id,NEW.legal_entity_id) OR NOT app_security.can_manage_accounts(NEW.organization_id)
    OR NEW.updated_by IS DISTINCT FROM current_setting('app.user_id',true) THEN RAISE EXCEPTION 'Invalid party authority'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NOT NEW.active OR NEW.created_by IS DISTINCT FROM current_setting('app.user_id',true) THEN RAISE EXCEPTION 'Invalid party creation'; END IF;
    INSERT INTO public.subledger_counterparties(organization_id,legal_entity_id,id,created_by) VALUES(NEW.organization_id,NEW.legal_entity_id,NEW.id,NEW.created_by);
    NEW.created_at:=clock_timestamp();
  ELSE
    IF NOT OLD.active OR NEW.version<>OLD.version+1 OR (to_jsonb(NEW)-ARRAY['name','name_key','role_set','contact','address','tax_identifier','tax_key','payment_terms_days','credit_limit','active','version','updated_by','updated_at','archived_by','archived_at','archive_reason'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['name','name_key','role_set','contact','address','tax_identifier','tax_key','payment_terms_days','credit_limit','active','version','updated_by','updated_at','archived_by','archived_at','archive_reason'])
      THEN RAISE EXCEPTION 'Immutable party identity'; END IF;
    IF EXISTS(SELECT 1 FROM public.subledger_sources s WHERE s.organization_id=OLD.organization_id AND s.legal_entity_id=OLD.legal_entity_id AND s.party_id=OLD.id
      AND ((s.kind IN ('ar_item','ar_deposit','ar_direct') AND NOT NEW.role_set ? 'customer') OR (s.kind IN ('ap_item','ap_advance','ap_direct') AND NOT NEW.role_set ? 'supplier'))) THEN RAISE EXCEPTION 'Used party role cannot be removed'; END IF;
    IF NOT NEW.active THEN
      IF NEW.archived_by IS DISTINCT FROM current_setting('app.user_id',true) OR NEW.archived_at IS NULL OR (to_jsonb(NEW)-ARRAY['name_key','tax_key','active','version','updated_by','updated_at','archived_by','archived_at','archive_reason'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['name_key','tax_key','active','version','updated_by','updated_at','archived_by','archived_at','archive_reason']) THEN RAISE EXCEPTION 'Invalid party archive'; END IF;
      IF EXISTS(SELECT 1 FROM public.subledger_open_items i WHERE i.organization_id=OLD.organization_id AND i.legal_entity_id=OLD.legal_entity_id AND i.party_id=OLD.id
        AND i.amount<>(SELECT coalesce(sum(CASE WHEN a.reversal_of IS NULL THEN a.amount ELSE -a.amount END),0) FROM public.subledger_allocations a WHERE a.organization_id=i.organization_id AND a.legal_entity_id=i.legal_entity_id AND a.open_item_id=i.id))
        OR EXISTS(SELECT 1 FROM public.subledger_settlements s WHERE s.organization_id=OLD.organization_id AND s.legal_entity_id=OLD.legal_entity_id AND s.party_id=OLD.id AND s.mode='on_account'
          AND s.amount<>(SELECT coalesce(sum(CASE WHEN a.reversal_of IS NULL THEN a.amount ELSE -a.amount END),0) FROM public.subledger_allocations a WHERE a.organization_id=s.organization_id AND a.legal_entity_id=s.legal_entity_id AND a.settlement_id=s.id))
        THEN RAISE EXCEPTION 'Party has unresolved balances or unapplied capacity'; END IF;
      NEW.archived_at:=clock_timestamp();
    END IF;
  END IF;
  NEW.updated_at:=clock_timestamp(); RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app_security.guard_registered_party_source() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.parties%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
  SELECT * INTO p FROM public.parties WHERE organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id AND id=NEW.party_id;
  IF FOUND AND (NEW.kind IN ('ar_item','ar_deposit','ar_direct') OR NEW.kind IN ('ap_item','ap_advance','ap_direct')) AND (NOT p.active OR (NEW.kind IN ('ar_item','ar_deposit','ar_direct') AND NOT p.role_set ? 'customer') OR (NEW.kind IN ('ap_item','ap_advance','ap_direct') AND NOT p.role_set ? 'supplier'))
    THEN RAISE EXCEPTION 'Active party role required'; END IF;
  RETURN NEW;
END $$;
