-- This immutable register is not an activation or financial posting permit.
CREATE FUNCTION app_security.can_read_rules(org uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT org::text=current_setting('app.org_id',true) AND EXISTS(SELECT 1 FROM public.memberships m WHERE m.organization_id=org AND m.user_id=current_setting('app.user_id',true)
    AND m.active AND m.roles ?| ARRAY['finance_manager','accountant','auditor','policy_reviewer'])
$$;
CREATE TABLE rule_versions (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL,
  definition jsonb NOT NULL, content_hash text NOT NULL,
  jurisdiction text NOT NULL DEFAULT 'NP' CHECK(jurisdiction='NP'), currency text NOT NULL DEFAULT 'NPR' CHECK(currency='NPR'),
  evaluator_version text NOT NULL DEFAULT 'tax-line-v1' CHECK(evaluator_version='tax-line-v1'),
  status text NOT NULL DEFAULT 'draft' CHECK(status='draft'), version integer NOT NULL DEFAULT 1 CHECK(version=1),
  created_by text NOT NULL REFERENCES auth_user(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,legal_entity_id,id), FOREIGN KEY(organization_id,legal_entity_id) REFERENCES legal_entities(organization_id,id),
  CHECK(content_hash ~ '^[a-f0-9]{64}$')
);
ALTER TABLE rule_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY rules_read ON rule_versions FOR SELECT USING(app_security.finance_setup_scope(organization_id,legal_entity_id) AND app_security.can_read_rules(organization_id));
CREATE POLICY rules_insert ON rule_versions FOR INSERT WITH CHECK(app_security.finance_setup_scope(organization_id,legal_entity_id) AND app_security.can_manage_accounts(organization_id));
CREATE TRIGGER rule_immutable BEFORE UPDATE OR DELETE ON rule_versions FOR EACH ROW EXECUTE FUNCTION app_security.append_only();

CREATE FUNCTION app_security.guard_rule_draft() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d jsonb:=NEW.definition; t jsonb; s jsonb; start_date date; end_date date;
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
  IF NOT app_security.finance_setup_scope(NEW.organization_id,NEW.legal_entity_id) OR NOT app_security.can_manage_accounts(NEW.organization_id)
    OR NEW.created_by IS DISTINCT FROM current_setting('app.user_id',true) THEN RAISE EXCEPTION 'Invalid rule draft authority'; END IF;
  IF NOT coalesce(jsonb_typeof(d)='object' AND d-ARRAY['kind','applicability','effectiveFrom','effectiveTo','definition','sourceReferences','demoOnly']='{}'
    AND d->>'kind' IN ('sales_tax','purchase_tax') AND jsonb_typeof(d->'demoOnly')='boolean'
    AND jsonb_typeof(d->'applicability')='object' AND d->'applicability'-ARRAY['event','taxCode']='{}'
    AND d->'applicability'->>'event'=CASE d->>'kind' WHEN 'sales_tax' THEN 'invoice' ELSE 'bill' END
    AND jsonb_typeof(d->'applicability'->'taxCode')='string' AND d->'applicability'->>'taxCode' ~ '^[A-Z][A-Z0-9_-]{0,39}$'
    AND jsonb_typeof(d->'effectiveFrom')='string' AND d->>'effectiveFrom' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND (NOT d ? 'effectiveTo' OR (jsonb_typeof(d->'effectiveTo')='string' AND d->>'effectiveTo' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')),false)
    THEN RAISE EXCEPTION 'Invalid typed rule draft'; END IF;
  start_date:=(d->>'effectiveFrom')::date; end_date:=(d->>'effectiveTo')::date;
  IF start_date<DATE '1900-01-01' OR start_date>DATE '9999-12-31' OR (end_date IS NOT NULL AND (end_date<=start_date OR end_date>DATE '9999-12-31')) THEN RAISE EXCEPTION 'Invalid rule interval'; END IF;
  t:=d->'definition';
  IF NOT coalesce(jsonb_typeof(t)='object' AND t->>'rounding'='half_up_line' AND (
    (t->>'method'='percentage' AND t-ARRAY['method','rate','basis','rounding','inputCredit']='{}'
      AND jsonb_typeof(t->'rate')='string' AND t->>'rate' ~ '^(0|[1-9][0-9]{0,2})(\.[0-9]{1,8})?$'
      AND t->>'basis' IN ('exclusive','inclusive') AND
      ((d->>'kind'='sales_tax' AND t->>'inputCredit'='not_applicable') OR (d->>'kind'='purchase_tax' AND t->>'inputCredit' IN ('eligible','ineligible'))))
    OR (t->>'method'='no_tax' AND t-ARRAY['method','treatment','rounding','inputCredit']='{}'
      AND t->>'treatment' IN ('zero_rated','exempt','out_of_scope') AND t->>'inputCredit'='not_applicable')),false)
    THEN RAISE EXCEPTION 'Invalid typed tax definition'; END IF;
  IF t->>'method'='percentage' AND ((t->>'rate')::numeric<=0 OR (t->>'rate')::numeric>100) THEN RAISE EXCEPTION 'Invalid percentage'; END IF;
  IF jsonb_typeof(d->'sourceReferences') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Source references required'; END IF;
  IF jsonb_array_length(d->'sourceReferences') NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'Source reference limit'; END IF;
  FOR s IN SELECT value FROM jsonb_array_elements(d->'sourceReferences') LOOP
    IF NOT coalesce(jsonb_typeof(s)='object' AND s-ARRAY['title','url','section','sha256']='{}'
      AND jsonb_typeof(s->'title')='string' AND length(btrim(s->>'title')) BETWEEN 1 AND 300
      AND jsonb_typeof(s->'section')='string' AND length(btrim(s->>'section')) BETWEEN 1 AND 500
      AND jsonb_typeof(s->'url')='string' AND length(s->>'url')<=2000 AND s->>'url' ~ '^https://[^/?#@[:space:]]+([/?#][^[:space:]]*)?$'
      AND jsonb_typeof(s->'sha256')='string' AND s->>'sha256' ~ '^[a-f0-9]{64}$',false) THEN RAISE EXCEPTION 'Invalid source reference'; END IF;
  END LOOP;
  IF (SELECT count(*) FROM (SELECT DISTINCT value->>'url',value->>'section',value->>'sha256' FROM jsonb_array_elements(d->'sourceReferences')) refs)<>jsonb_array_length(d->'sourceReferences') THEN RAISE EXCEPTION 'Repeated source reference'; END IF;
  IF (d->>'demoOnly')::boolean AND NOT EXISTS(SELECT 1 FROM public.legal_entities WHERE organization_id=NEW.organization_id AND id=NEW.legal_entity_id AND policy_status='demo' AND reporting_profile='demo_accrual') THEN RAISE EXCEPTION 'Synthetic rules require a demo company'; END IF;
  NEW.created_at:=clock_timestamp();
  NEW.content_hash:=encode(sha256(convert_to(d::text,'UTF8')),'hex');
  RETURN NEW;
END $$;
CREATE TRIGGER rule_draft_guard BEFORE INSERT ON rule_versions FOR EACH ROW EXECUTE FUNCTION app_security.guard_rule_draft();
REVOKE ALL ON FUNCTION app_security.can_read_rules(uuid),app_security.guard_rule_draft() FROM PUBLIC;
