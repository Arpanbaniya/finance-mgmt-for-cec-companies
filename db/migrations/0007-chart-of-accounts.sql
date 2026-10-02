CREATE TABLE accounts (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL,
  code text NOT NULL CHECK(code ~ '^[A-Z0-9][A-Z0-9._-]{0,99}$'), name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200),
  type text NOT NULL CHECK(type IN ('asset','liability','equity','revenue','expense')),
  normal_side text NOT NULL CHECK(normal_side IN ('debit','credit')), parent_id uuid,
  is_control boolean NOT NULL, control_type text,
  report_section text NOT NULL, cash_flow_category text NOT NULL CHECK(cash_flow_category IN ('unclassified','operating','investing','financing','cash')),
  active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_by text NOT NULL REFERENCES auth_user(id), updated_by text NOT NULL REFERENCES auth_user(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  archived_by text REFERENCES auth_user(id), archived_at timestamptz, archive_reason text,
  UNIQUE(organization_id,legal_entity_id,id), UNIQUE(organization_id,legal_entity_id,code),
  FOREIGN KEY(organization_id,legal_entity_id) REFERENCES legal_entities(organization_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,parent_id) REFERENCES accounts(organization_id,legal_entity_id,id),
  CHECK(parent_id IS DISTINCT FROM id),
  CHECK((is_control AND control_type IS NOT NULL) OR (NOT is_control AND control_type IS NULL)),
  CHECK(control_type IS NULL OR (type='asset' AND control_type IN ('ar','cash','worker_advances','tax_receivable','supplier_advances','staff_advances'))
    OR (type='liability' AND control_type IN ('ap','wages_payable','tax_payable','statutory_payable','customer_deposits','employee_reimbursements'))),
  CHECK(report_section=CASE type WHEN 'asset' THEN 'assets' WHEN 'liability' THEN 'liabilities' WHEN 'equity' THEN 'equity' WHEN 'revenue' THEN 'revenue' WHEN 'expense' THEN 'expenses' END),
  CHECK((coalesce(control_type='cash',false))=(cash_flow_category='cash')),
  CHECK((active AND archived_by IS NULL AND archived_at IS NULL AND archive_reason IS NULL)
    OR (NOT active AND archived_by IS NOT NULL AND archived_at IS NOT NULL AND length(btrim(archive_reason)) BETWEEN 3 AND 1000))
);
CREATE INDEX accounts_parent ON accounts(organization_id,legal_entity_id,parent_id) WHERE active;
CREATE TABLE account_versions (
  organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL, account_id uuid NOT NULL, version integer NOT NULL,
  snapshot jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,legal_entity_id,account_id,version),
  FOREIGN KEY(organization_id,legal_entity_id,account_id) REFERENCES accounts(organization_id,legal_entity_id,id)
);
CREATE FUNCTION app_security.can_read_accounts(org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT org::text=current_setting('app.org_id',true) AND EXISTS(SELECT 1 FROM public.memberships WHERE organization_id=org
    AND user_id=current_setting('app.user_id',true) AND active AND roles ?| ARRAY['finance_manager','accountant','auditor'])
$$;
CREATE FUNCTION app_security.can_manage_accounts(org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT org::text=current_setting('app.org_id',true) AND EXISTS(SELECT 1 FROM public.memberships WHERE organization_id=org
    AND user_id=current_setting('app.user_id',true) AND active AND roles ? 'finance_manager')
$$;
REVOKE ALL ON FUNCTION app_security.can_read_accounts(uuid),app_security.can_manage_accounts(uuid) FROM PUBLIC;
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounts_read ON accounts FOR SELECT USING (organization_id::text=current_setting('app.org_id',true)
  AND legal_entity_id::text=current_setting('app.entity_id',true) AND app_security.can_entity(organization_id,legal_entity_id) AND app_security.can_read_accounts(organization_id));
CREATE POLICY accounts_insert ON accounts FOR INSERT WITH CHECK (organization_id::text=current_setting('app.org_id',true)
  AND legal_entity_id::text=current_setting('app.entity_id',true) AND app_security.can_entity(organization_id,legal_entity_id) AND app_security.can_manage_accounts(organization_id));
CREATE POLICY accounts_update ON accounts FOR UPDATE USING (organization_id::text=current_setting('app.org_id',true)
  AND legal_entity_id::text=current_setting('app.entity_id',true) AND app_security.can_entity(organization_id,legal_entity_id) AND app_security.can_manage_accounts(organization_id))
  WITH CHECK (organization_id::text=current_setting('app.org_id',true) AND legal_entity_id::text=current_setting('app.entity_id',true)
  AND app_security.can_entity(organization_id,legal_entity_id) AND app_security.can_manage_accounts(organization_id));
ALTER TABLE account_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_versions_read ON account_versions FOR SELECT USING (organization_id::text=current_setting('app.org_id',true)
  AND legal_entity_id::text=current_setting('app.entity_id',true) AND app_security.can_entity(organization_id,legal_entity_id) AND app_security.can_read_accounts(organization_id));
CREATE TRIGGER account_version_append_only BEFORE UPDATE OR DELETE ON account_versions FOR EACH ROW EXECUTE FUNCTION app_security.append_only();
CREATE TRIGGER account_no_delete BEFORE DELETE ON accounts FOR EACH ROW EXECUTE FUNCTION app_security.append_only();
CREATE FUNCTION app_security.guard_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
  IF NEW.organization_id::text IS DISTINCT FROM current_setting('app.org_id',true)
    OR NEW.legal_entity_id::text IS DISTINCT FROM current_setting('app.entity_id',true)
    OR NOT app_security.can_manage_accounts(NEW.organization_id) OR NOT app_security.can_entity(NEW.organization_id,NEW.legal_entity_id)
    OR NEW.updated_by IS DISTINCT FROM current_setting('app.user_id',true) THEN RAISE EXCEPTION 'Invalid account authority'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NOT NEW.active OR NEW.created_by IS DISTINCT FROM current_setting('app.user_id',true) THEN RAISE EXCEPTION 'Invalid account creation'; END IF;
    NEW.created_at:=clock_timestamp();
  ELSE
    IF NOT OLD.active OR NEW.version<>OLD.version+1
      OR (to_jsonb(NEW)-ARRAY['name','parent_id','report_section','cash_flow_category','active','version','updated_by','updated_at','archived_by','archived_at','archive_reason'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['name','parent_id','report_section','cash_flow_category','active','version','updated_by','updated_at','archived_by','archived_at','archive_reason'])
      THEN RAISE EXCEPTION 'Immutable account identity or classification'; END IF;
    IF NOT NEW.active THEN
      IF NEW.archived_by IS DISTINCT FROM current_setting('app.user_id',true) OR NEW.archived_at IS NULL
        OR (to_jsonb(NEW)-ARRAY['active','version','updated_by','updated_at','archived_by','archived_at','archive_reason'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['active','version','updated_by','updated_at','archived_by','archived_at','archive_reason'])
        OR EXISTS(SELECT 1 FROM public.accounts WHERE organization_id=OLD.organization_id AND legal_entity_id=OLD.legal_entity_id AND parent_id=OLD.id AND active)
        THEN RAISE EXCEPTION 'Account has active dependencies or invalid archive'; END IF;
      NEW.archived_at:=clock_timestamp();
    END IF;
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM public.accounts WHERE id=NEW.parent_id AND organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id
      AND active AND type=NEW.type AND NOT is_control) THEN RAISE EXCEPTION 'Invalid account parent'; END IF;
    IF EXISTS(WITH RECURSIVE ancestors AS (
      SELECT id,parent_id FROM public.accounts WHERE id=NEW.parent_id AND organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id
      UNION SELECT a.id,a.parent_id FROM public.accounts a JOIN ancestors p ON a.id=p.parent_id
        WHERE a.organization_id=NEW.organization_id AND a.legal_entity_id=NEW.legal_entity_id
    ) SELECT 1 FROM ancestors WHERE id=NEW.id) THEN RAISE EXCEPTION 'Account hierarchy cycle'; END IF;
  END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER account_guard BEFORE INSERT OR UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION app_security.guard_account();
CREATE FUNCTION app_security.record_account_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  INSERT INTO public.account_versions(organization_id,legal_entity_id,account_id,version,snapshot)
    VALUES(NEW.organization_id,NEW.legal_entity_id,NEW.id,NEW.version,to_jsonb(NEW));
  RETURN NEW;
END $$;
CREATE TRIGGER account_version_record AFTER INSERT OR UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION app_security.record_account_version();
REVOKE ALL ON FUNCTION app_security.guard_account(),app_security.record_account_version() FROM PUBLIC;
