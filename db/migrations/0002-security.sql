CREATE SCHEMA IF NOT EXISTS app_security;
REVOKE ALL ON SCHEMA app_security FROM PUBLIC;

-- Owned by the migration administrator. It exposes only the caller's membership
-- predicates, never membership data, and uses a fixed search path.
CREATE OR REPLACE FUNCTION app_security.is_member(org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.memberships m WHERE m.organization_id = org
    AND m.user_id = current_setting('app.user_id', true) AND m.active)
$$;
CREATE OR REPLACE FUNCTION app_security.is_admin(org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.memberships m WHERE m.organization_id = org
    AND m.user_id = current_setting('app.user_id', true) AND m.active AND m.roles ? 'organization_admin')
$$;
CREATE OR REPLACE FUNCTION app_security.can_entity(org uuid, entity uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.memberships m WHERE m.organization_id = org
    AND m.user_id = current_setting('app.user_id', true) AND m.active AND m.allowed_entity_ids ? entity::text)
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_security FROM PUBLIC;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY organizations_read ON organizations FOR SELECT USING (
  id::text = current_setting('app.org_id',true) AND app_security.is_member(id));
CREATE POLICY memberships_read ON memberships FOR SELECT USING (
  (organization_id::text = current_setting('app.org_id',true) AND
  (user_id = current_setting('app.user_id',true) OR app_security.is_admin(organization_id))) OR
  (nullif(current_setting('app.org_id',true),'') IS NULL AND user_id = current_setting('app.user_id',true) AND active));
CREATE POLICY memberships_insert ON memberships FOR INSERT WITH CHECK (
  organization_id::text = current_setting('app.org_id',true) AND app_security.is_admin(organization_id)
  AND user_id <> current_setting('app.user_id',true));
CREATE POLICY memberships_update ON memberships FOR UPDATE USING (
  organization_id::text = current_setting('app.org_id',true) AND app_security.is_admin(organization_id)
  AND user_id <> current_setting('app.user_id',true)) WITH CHECK (
  organization_id::text = current_setting('app.org_id',true) AND app_security.is_admin(organization_id)
  AND user_id <> current_setting('app.user_id',true));
CREATE POLICY entities_read ON legal_entities FOR SELECT USING (
  organization_id::text = current_setting('app.org_id',true) AND app_security.is_member(organization_id)
  AND (id::text = current_setting('app.entity_id',true) OR nullif(current_setting('app.entity_id',true),'') IS NULL)
  AND app_security.can_entity(organization_id,id));
CREATE POLICY entities_insert ON legal_entities FOR INSERT WITH CHECK (
  organization_id::text = current_setting('app.org_id',true) AND app_security.is_admin(organization_id));
CREATE POLICY entities_update ON legal_entities FOR UPDATE USING (
  organization_id::text = current_setting('app.org_id',true) AND app_security.is_admin(organization_id)
  AND app_security.can_entity(organization_id,id)) WITH CHECK (
  organization_id::text = current_setting('app.org_id',true) AND app_security.is_admin(organization_id)
  AND app_security.can_entity(organization_id,id));
CREATE POLICY branches_scoped ON branches USING (
  organization_id::text = current_setting('app.org_id',true) AND legal_entity_id::text = current_setting('app.entity_id',true)
  AND app_security.can_entity(organization_id,legal_entity_id));
CREATE POLICY audit_read ON audit_events FOR SELECT USING (
  organization_id::text = current_setting('app.org_id',true) AND app_security.is_member(organization_id)
  AND (legal_entity_id IS NULL OR (legal_entity_id::text = current_setting('app.entity_id',true) AND app_security.can_entity(organization_id,legal_entity_id))));
CREATE POLICY audit_insert ON audit_events FOR INSERT WITH CHECK (
  organization_id::text = current_setting('app.org_id',true) AND actor_id = current_setting('app.user_id',true) AND app_security.is_member(organization_id));
CREATE POLICY idempotency_scoped ON idempotency_results USING (
  organization_id::text = current_setting('app.org_id',true) AND principal_id = current_setting('app.user_id',true)
  AND app_security.is_member(organization_id));

ALTER TABLE legal_entities ADD CONSTRAINT entity_currency CHECK (base_currency = 'NPR');
ALTER TABLE legal_entities ADD CONSTRAINT entity_timezone CHECK (timezone = 'Asia/Kathmandu');
ALTER TABLE legal_entities ADD CONSTRAINT entity_profile CHECK (reporting_profile IN ('demo_accrual','review_required'));
ALTER TABLE legal_entities ADD CONSTRAINT entity_modes CHECK (active_modes <@ '["labour"]'::jsonb AND jsonb_array_length(active_modes)>0);
ALTER TABLE memberships ADD CONSTRAINT membership_arrays CHECK (jsonb_typeof(roles)='array' AND jsonb_typeof(allowed_entity_ids)='array' AND jsonb_typeof(site_ids)='array');
ALTER TABLE memberships ADD CONSTRAINT membership_roles CHECK (roles <@ '["organization_admin","owner","finance_manager","accountant","auditor","site_supervisor"]'::jsonb);
ALTER TABLE audit_events ADD CONSTRAINT audit_entity_fk FOREIGN KEY (organization_id,legal_entity_id) REFERENCES legal_entities(organization_id,id);
ALTER TABLE audit_events ADD CONSTRAINT audit_org_fk FOREIGN KEY (organization_id) REFERENCES organizations(id);

CREATE FUNCTION app_security.guard_membership() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE value text;
BEGIN
  -- Serialize grant changes within one organization for last-admin safety.
  PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
  IF TG_OP='UPDATE' AND (NEW.organization_id<>OLD.organization_id OR NEW.user_id<>OLD.user_id) THEN
    RAISE EXCEPTION 'Membership identity is immutable';
  END IF;
  IF TG_OP='UPDATE' AND OLD.active AND OLD.roles ? 'organization_admin'
    AND (NOT NEW.active OR NOT NEW.roles ? 'organization_admin')
    AND NOT EXISTS(SELECT 1 FROM public.memberships WHERE organization_id=OLD.organization_id
      AND id<>OLD.id AND active AND roles ? 'organization_admin') THEN
    RAISE EXCEPTION 'Cannot revoke last administrator';
  END IF;
  FOR value IN SELECT jsonb_array_elements_text(NEW.allowed_entity_ids) LOOP
    IF NOT EXISTS (SELECT 1 FROM public.legal_entities WHERE id=value::uuid AND organization_id=NEW.organization_id) THEN
      RAISE EXCEPTION 'Entity grant belongs to another organization';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER membership_guard BEFORE INSERT OR UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION app_security.guard_membership();

CREATE FUNCTION app_security.grant_created_entity(org uuid, entity uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
BEGIN
  IF org::text<>current_setting('app.org_id',true) OR NOT app_security.is_admin(org)
    OR NOT EXISTS(SELECT 1 FROM public.legal_entities WHERE id=entity AND organization_id=org AND created_by=current_setting('app.user_id',true)) THEN
    RAISE EXCEPTION 'Cannot grant unrelated entity';
  END IF;
  UPDATE public.memberships SET allowed_entity_ids=allowed_entity_ids || to_jsonb(entity::text),version=version+1
    WHERE organization_id=org AND user_id=current_setting('app.user_id',true) AND NOT allowed_entity_ids ? entity::text;
END $$;
REVOKE ALL ON FUNCTION app_security.grant_created_entity(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION app_security.guard_entity_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id<>OLD.organization_id OR NEW.id<>OLD.id OR NEW.created_by<>OLD.created_by THEN RAISE EXCEPTION 'Entity identity is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER entity_scope_guard BEFORE UPDATE ON legal_entities FOR EACH ROW EXECUTE FUNCTION app_security.guard_entity_scope();

CREATE FUNCTION app_security.append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Audit history is append-only'; END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION app_security.append_only();
