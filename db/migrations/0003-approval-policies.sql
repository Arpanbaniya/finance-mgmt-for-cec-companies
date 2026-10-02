ALTER TABLE memberships DROP CONSTRAINT membership_roles;
ALTER TABLE memberships ADD CONSTRAINT membership_roles CHECK (roles <@ '["organization_admin","owner","finance_manager","accountant","auditor","site_supervisor","policy_reviewer"]'::jsonb);

CREATE TABLE approval_policies (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL,
  definition jsonb NOT NULL, canonical_payload text NOT NULL, content_hash text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0), created_by text NOT NULL REFERENCES auth_user(id),
  created_at timestamptz NOT NULL DEFAULT now(), activated_by text REFERENCES auth_user(id),
  activated_at timestamptz, activation_reason text,
  FOREIGN KEY (organization_id,legal_entity_id) REFERENCES legal_entities(organization_id,id),
  UNIQUE(organization_id,legal_entity_id,id),
  CHECK (canonical_payload::jsonb=definition),
  CHECK (content_hash=encode(sha256(convert_to(canonical_payload,'UTF8')),'hex')),
  CHECK ((status='draft' AND version=1 AND activated_by IS NULL AND activated_at IS NULL AND activation_reason IS NULL)
    OR (status='active' AND version=2 AND activated_by IS NOT NULL AND activated_by<>created_by AND activated_at IS NOT NULL))
);
CREATE INDEX approval_policy_scope ON approval_policies(organization_id,legal_entity_id,id);
CREATE INDEX audit_event_scope ON audit_events(organization_id,legal_entity_id,id);

CREATE FUNCTION app_security.can_manage_policy(org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM public.memberships WHERE organization_id=org AND user_id=current_setting('app.user_id',true)
    AND active AND (roles ? 'organization_admin' OR roles ? 'finance_manager'))
$$;
CREATE FUNCTION app_security.can_activate_policy(org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT app_security.can_manage_policy(org) AND EXISTS(SELECT 1 FROM public.memberships WHERE organization_id=org
    AND user_id=current_setting('app.user_id',true) AND active AND roles ? 'policy_reviewer')
$$;
REVOKE ALL ON FUNCTION app_security.can_manage_policy(uuid),app_security.can_activate_policy(uuid) FROM PUBLIC;
CREATE FUNCTION app_security.lock_policy_scope(org uuid, entity uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF org::text IS DISTINCT FROM current_setting('app.org_id',true) OR entity::text IS DISTINCT FROM current_setting('app.entity_id',true)
    OR NOT app_security.can_entity(org,entity) THEN RAISE EXCEPTION 'Invalid policy scope'; END IF;
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
END $$;
REVOKE ALL ON FUNCTION app_security.lock_policy_scope(uuid,uuid) FROM PUBLIC;
ALTER TABLE approval_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY approval_policy_read ON approval_policies FOR SELECT USING (
  organization_id::text=current_setting('app.org_id',true) AND legal_entity_id::text=current_setting('app.entity_id',true)
  AND app_security.can_entity(organization_id,legal_entity_id));
CREATE POLICY approval_policy_insert ON approval_policies FOR INSERT WITH CHECK (
  organization_id::text=current_setting('app.org_id',true) AND legal_entity_id::text=current_setting('app.entity_id',true)
  AND app_security.can_entity(organization_id,legal_entity_id) AND app_security.can_manage_policy(organization_id)
  AND created_by=current_setting('app.user_id',true));
CREATE POLICY approval_policy_activate ON approval_policies FOR UPDATE USING (
  organization_id::text=current_setting('app.org_id',true) AND legal_entity_id::text=current_setting('app.entity_id',true)
  AND app_security.can_entity(organization_id,legal_entity_id) AND app_security.can_activate_policy(organization_id)
  AND created_by<>current_setting('app.user_id',true)) WITH CHECK (
  organization_id::text=current_setting('app.org_id',true) AND legal_entity_id::text=current_setting('app.entity_id',true)
  AND app_security.can_entity(organization_id,legal_entity_id) AND app_security.can_activate_policy(organization_id));

-- A second boundary protects direct runtime SQL, not only HTTP validation.
CREATE FUNCTION app_security.guard_approval_policy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d jsonb; row jsonb; kind text; next_amount numeric:=0; upper_amount numeric; n integer;
  permissions jsonb:='{"journal":"journals.approve","invoice":"invoices.approve","bill":"bills.approve","credit_note":"credit_notes.approve","settlement":"settlements.approve","transfer":"transfers.approve","expense":"expenses.approve","period_reopen_request":"periods.approve","reconciliation":"banking.approve","rate_version":"rates.approve","worker_private_change":"worker_private.approve","bank_private_change":"bank_private.approve","attendance":"attendance.approve","attendance_adjustment":"attendance.approve","advance":"advances.approve","payroll_run":"payroll.approve","billing_run":"billing.approve","import":"imports.approve","opening_batch":"opening.approve"}';
BEGIN
  -- Serializes activation overlap checks with membership revocation as well.
  PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
  IF TG_OP='INSERT' THEN
    IF NEW.created_by IS DISTINCT FROM current_setting('app.user_id',true) OR NEW.status<>'draft'
      OR NOT app_security.can_manage_policy(NEW.organization_id) THEN RAISE EXCEPTION 'Invalid policy maker'; END IF;
    d:=NEW.definition;
    IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT d ?& ARRAY['name','effectiveFrom','aggregateTypes','currency','thresholds','makerChecker']
      OR (d-ARRAY['name','effectiveFrom','effectiveTo','aggregateTypes','currency','thresholds','makerChecker'])<>'{}'::jsonb
      OR jsonb_typeof(d->'name') IS DISTINCT FROM 'string' OR length(btrim(d->>'name')) NOT BETWEEN 1 AND 200
      OR d->>'currency' IS DISTINCT FROM 'NPR' OR d->'makerChecker' IS DISTINCT FROM 'true'::jsonb
      OR jsonb_typeof(d->'aggregateTypes') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'aggregateTypes') NOT BETWEEN 1 AND 19
      OR jsonb_typeof(d->'thresholds') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'thresholds') NOT BETWEEN 1 AND 50
      OR coalesce(d->>'effectiveFrom','') !~ '^\d{4}-\d{2}-\d{2}$'
      OR (d->>'effectiveFrom')::date NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' THEN RAISE EXCEPTION 'Invalid policy definition'; END IF;
    IF d ? 'effectiveTo' AND (coalesce(d->>'effectiveTo','') !~ '^\d{4}-\d{2}-\d{2}$'
      OR (d->>'effectiveTo')::date <= (d->>'effectiveFrom')::date OR (d->>'effectiveTo')::date>DATE '9999-12-31') THEN RAISE EXCEPTION 'Invalid policy interval'; END IF;
    IF (SELECT count(DISTINCT value) FROM jsonb_array_elements(d->'aggregateTypes'))<>jsonb_array_length(d->'aggregateTypes') THEN RAISE EXCEPTION 'Repeated aggregate'; END IF;
    FOR kind IN SELECT jsonb_array_elements_text(d->'aggregateTypes') LOOP
      IF NOT permissions ? kind THEN RAISE EXCEPTION 'Unknown aggregate'; END IF;
    END LOOP;
    FOR row IN SELECT value FROM jsonb_array_elements(d->'thresholds') LOOP
      IF jsonb_typeof(row) IS DISTINCT FROM 'object' OR NOT row ?& ARRAY['minInclusive','requiredPermission','numberOfDistinctApprovers']
        OR (row-ARRAY['minInclusive','maxExclusive','requiredPermission','numberOfDistinctApprovers'])<>'{}'::jsonb
        OR jsonb_typeof(row->'minInclusive') IS DISTINCT FROM 'string' OR coalesce(row->>'minInclusive','') !~ '^(0|[1-9]\d*)(\.\d{1,2})?$'
        OR next_amount IS NULL OR (row->>'minInclusive')::numeric<>next_amount THEN RAISE EXCEPTION 'Incomplete threshold coverage'; END IF;
      upper_amount:=NULL;
      IF row ? 'maxExclusive' THEN
        IF jsonb_typeof(row->'maxExclusive') IS DISTINCT FROM 'string' OR coalesce(row->>'maxExclusive','') !~ '^(0|[1-9]\d*)(\.\d{1,2})?$' THEN RAISE EXCEPTION 'Invalid upper threshold'; END IF;
        upper_amount:=(row->>'maxExclusive')::numeric;
        IF upper_amount<=next_amount OR upper_amount>999999999999999999.99 THEN RAISE EXCEPTION 'Invalid upper threshold'; END IF;
      END IF;
      IF jsonb_typeof(row->'numberOfDistinctApprovers') IS DISTINCT FROM 'number' OR (row->>'numberOfDistinctApprovers') !~ '^\d+$' THEN RAISE EXCEPTION 'Invalid approver count'; END IF;
      n:=(row->>'numberOfDistinctApprovers')::integer;
      IF n NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'Invalid approver count'; END IF;
      FOR kind IN SELECT jsonb_array_elements_text(d->'aggregateTypes') LOOP
        IF row->>'requiredPermission' IS DISTINCT FROM permissions->>kind THEN RAISE EXCEPTION 'Permission mismatch'; END IF;
      END LOOP;
      next_amount:=upper_amount;
    END LOOP;
    IF next_amount IS NOT NULL THEN RAISE EXCEPTION 'Final threshold must be unbounded'; END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['status','version','activated_by','activated_at','activation_reason']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['status','version','activated_by','activated_at','activation_reason'])
      OR OLD.status<>'draft' OR NEW.status<>'active' OR NEW.version<>OLD.version+1
      OR NEW.activated_by IS DISTINCT FROM current_setting('app.user_id',true) OR NEW.activated_by=OLD.created_by
      OR NOT app_security.can_activate_policy(NEW.organization_id) OR NEW.activated_at IS DISTINCT FROM now()
      OR (NEW.activation_reason IS NOT NULL AND length(btrim(NEW.activation_reason)) NOT BETWEEN 3 AND 1000) THEN RAISE EXCEPTION 'Invalid independent policy activation'; END IF;
    IF EXISTS(SELECT 1 FROM public.approval_policies p WHERE p.organization_id=NEW.organization_id AND p.legal_entity_id=NEW.legal_entity_id
      AND p.id<>NEW.id AND p.status='active' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.definition->'aggregateTypes') k WHERE p.definition->'aggregateTypes' ? k)
      AND daterange((p.definition->>'effectiveFrom')::date,(p.definition->>'effectiveTo')::date,'[)') &&
        daterange((NEW.definition->>'effectiveFrom')::date,(NEW.definition->>'effectiveTo')::date,'[)')) THEN RAISE EXCEPTION 'Overlapping active approval policy'; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_security.guard_approval_policy() FROM PUBLIC;
CREATE TRIGGER approval_policy_guard BEFORE INSERT OR UPDATE ON approval_policies FOR EACH ROW EXECUTE FUNCTION app_security.guard_approval_policy();
CREATE TRIGGER approval_policy_no_delete BEFORE DELETE ON approval_policies FOR EACH ROW EXECUTE FUNCTION app_security.append_only();

-- Entity audit SQL must not expose unrelated organization membership changes.
DROP POLICY audit_read ON audit_events;
CREATE POLICY audit_read ON audit_events FOR SELECT USING (
  organization_id::text=current_setting('app.org_id',true) AND app_security.is_member(organization_id)
  AND ((nullif(current_setting('app.entity_id',true),'') IS NULL AND app_security.is_admin(organization_id))
    OR (app_security.can_entity(organization_id,nullif(current_setting('app.entity_id',true),'')::uuid)
      AND (legal_entity_id::text=current_setting('app.entity_id',true)
        OR (legal_entity_id IS NULL AND action IN ('entity.create','entity.update') AND target_id::text=current_setting('app.entity_id',true))))));
