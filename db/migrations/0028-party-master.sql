CREATE TABLE parties (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL,
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200),
  name_key text GENERATED ALWAYS AS (lower(regexp_replace(btrim(name),'[[:space:]]+',' ','g'))) STORED,
  role_set jsonb NOT NULL CHECK(role_set IN ('["customer"]'::jsonb,'["supplier"]'::jsonb,'["customer","supplier"]'::jsonb)),
  contact text CHECK(contact IS NULL OR length(btrim(contact)) BETWEEN 1 AND 2000),
  address text CHECK(address IS NULL OR length(btrim(address)) BETWEEN 1 AND 2000),
  tax_identifier text CHECK(tax_identifier IS NULL OR length(btrim(tax_identifier)) BETWEEN 1 AND 100),
  tax_key text GENERATED ALWAYS AS (lower(btrim(tax_identifier))) STORED,
  payment_terms_days integer NOT NULL DEFAULT 0 CHECK(payment_terms_days BETWEEN 0 AND 3650),
  credit_limit numeric(20,2) CHECK(credit_limit>=0 AND role_set ? 'customer'),
  active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_by text NOT NULL REFERENCES auth_user(id), updated_by text NOT NULL REFERENCES auth_user(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  archived_by text REFERENCES auth_user(id), archived_at timestamptz, archive_reason text,
  UNIQUE(organization_id,legal_entity_id,id), UNIQUE(organization_id,legal_entity_id,name_key), UNIQUE(organization_id,legal_entity_id,tax_key),
  FOREIGN KEY(organization_id,legal_entity_id) REFERENCES legal_entities(organization_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,id) REFERENCES subledger_counterparties(organization_id,legal_entity_id,id),
  CHECK((active AND archived_by IS NULL AND archived_at IS NULL AND archive_reason IS NULL)
    OR (NOT active AND archived_by IS NOT NULL AND archived_at IS NOT NULL AND length(btrim(archive_reason)) BETWEEN 3 AND 1000))
);
CREATE TABLE party_versions (
  organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL, party_id uuid NOT NULL, version integer NOT NULL,
  snapshot jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,legal_entity_id,party_id,version),
  FOREIGN KEY(organization_id,legal_entity_id,party_id) REFERENCES parties(organization_id,legal_entity_id,id)
);
ALTER TABLE parties ENABLE ROW LEVEL SECURITY;
CREATE POLICY parties_read ON parties FOR SELECT USING(app_security.finance_setup_scope(organization_id,legal_entity_id) AND app_security.can_read_accounts(organization_id));
CREATE POLICY parties_insert ON parties FOR INSERT WITH CHECK(app_security.finance_setup_scope(organization_id,legal_entity_id) AND app_security.can_manage_accounts(organization_id));
CREATE POLICY parties_update ON parties FOR UPDATE USING(app_security.finance_setup_scope(organization_id,legal_entity_id) AND app_security.can_manage_accounts(organization_id))
  WITH CHECK(app_security.finance_setup_scope(organization_id,legal_entity_id) AND app_security.can_manage_accounts(organization_id));
ALTER TABLE party_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY party_versions_read ON party_versions FOR SELECT USING(app_security.finance_setup_scope(organization_id,legal_entity_id) AND app_security.can_read_accounts(organization_id));
CREATE TRIGGER party_no_delete BEFORE DELETE ON parties FOR EACH ROW EXECUTE FUNCTION app_security.append_only();
CREATE TRIGGER party_version_immutable BEFORE UPDATE OR DELETE ON party_versions FOR EACH ROW EXECUTE FUNCTION app_security.append_only();

CREATE FUNCTION app_security.guard_party() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
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
      AND ((s.kind LIKE 'ar_%' AND NOT NEW.role_set ? 'customer') OR (s.kind LIKE 'ap_%' AND NOT NEW.role_set ? 'supplier'))) THEN RAISE EXCEPTION 'Used party role cannot be removed'; END IF;
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
CREATE TRIGGER party_guard BEFORE INSERT OR UPDATE ON parties FOR EACH ROW EXECUTE FUNCTION app_security.guard_party();
CREATE FUNCTION app_security.record_party_version() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  INSERT INTO public.party_versions(organization_id,legal_entity_id,party_id,version,snapshot) VALUES(NEW.organization_id,NEW.legal_entity_id,NEW.id,NEW.version,to_jsonb(NEW));
  RETURN NEW;
END $$;
CREATE TRIGGER party_version_record AFTER INSERT OR UPDATE ON parties FOR EACH ROW EXECUTE FUNCTION app_security.record_party_version();

-- Old private fixture reservations remain identities, not fabricated public masters.
-- New master-backed originations require the corresponding active customer/supplier role.
CREATE FUNCTION app_security.guard_registered_party_source() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.parties%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
  SELECT * INTO p FROM public.parties WHERE organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id AND id=NEW.party_id;
  IF FOUND AND (NEW.kind LIKE 'ar_%' OR NEW.kind LIKE 'ap_%') AND (NOT p.active OR (NEW.kind LIKE 'ar_%' AND NOT p.role_set ? 'customer') OR (NEW.kind LIKE 'ap_%' AND NOT p.role_set ? 'supplier'))
    THEN RAISE EXCEPTION 'Active party role required'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER registered_party_source_guard BEFORE INSERT ON subledger_sources FOR EACH ROW EXECUTE FUNCTION app_security.guard_registered_party_source();
REVOKE ALL ON FUNCTION app_security.guard_party(),app_security.record_party_version(),app_security.guard_registered_party_source() FROM PUBLIC;
