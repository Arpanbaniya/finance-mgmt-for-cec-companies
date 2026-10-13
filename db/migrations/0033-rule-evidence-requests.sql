-- An upload reservation is not a capture, malware scan, hold or source review.
CREATE TABLE rule_evidence_requests (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL, rule_id uuid NOT NULL,
  declaration jsonb NOT NULL, source_references jsonb NOT NULL, demo_only boolean NOT NULL,
  sensitivity text NOT NULL DEFAULT 'internal' CHECK(sensitivity='internal'),
  status text NOT NULL DEFAULT 'pending_upload' CHECK(status='pending_upload'),
  scan_state text NOT NULL DEFAULT 'quarantined' CHECK(scan_state='quarantined'),
  created_by text NOT NULL REFERENCES auth_user(id), created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK(version=1),
  UNIQUE(organization_id,legal_entity_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,rule_id) REFERENCES rule_versions(organization_id,legal_entity_id,id)
);
ALTER TABLE rule_evidence_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY rule_evidence_read ON rule_evidence_requests FOR SELECT USING(app_security.finance_setup_scope(organization_id,legal_entity_id) AND app_security.can_read_rules(organization_id));
CREATE POLICY rule_evidence_create ON rule_evidence_requests FOR INSERT WITH CHECK(app_security.finance_setup_scope(organization_id,legal_entity_id) AND app_security.can_manage_accounts(organization_id));
CREATE TRIGGER rule_evidence_immutable BEFORE UPDATE OR DELETE ON rule_evidence_requests FOR EACH ROW EXECUTE FUNCTION app_security.append_only();
CREATE FUNCTION app_security.guard_rule_evidence_request() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d jsonb:=NEW.declaration; owner_definition jsonb; sources jsonb; filename text:=d->>'filename';
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
  IF NOT app_security.finance_setup_scope(NEW.organization_id,NEW.legal_entity_id) OR NOT app_security.can_manage_accounts(NEW.organization_id)
    OR NEW.created_by IS DISTINCT FROM current_setting('app.user_id',true) THEN RAISE EXCEPTION 'Invalid evidence request authority'; END IF;
  SELECT definition INTO owner_definition FROM public.rule_versions WHERE organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id AND id=NEW.rule_id;
  IF owner_definition IS NULL THEN RAISE EXCEPTION 'Rule evidence owner unavailable'; END IF;
  IF NOT coalesce(jsonb_typeof(d)='object' AND (d-ARRAY['filename','contentType','sizeBytes','sha256'])='{}'
    AND jsonb_typeof(d->'filename')='string' AND length(filename) BETWEEN 1 AND 200 AND filename=btrim(filename)
    AND filename !~ '[[:cntrl:]/:"<>|?*]' AND position(chr(92) in filename)=0 AND left(filename,1)<>'.' AND right(filename,1)<>'.'
    AND jsonb_typeof(d->'contentType')='string' AND ((d->>'contentType'='image/png' AND filename ~* '\.png$')
      OR (d->>'contentType'='image/jpeg' AND filename ~* '\.jpe?g$') OR (d->>'contentType'='application/pdf' AND filename ~* '\.pdf$'))
    AND jsonb_typeof(d->'sizeBytes')='number' AND d->>'sizeBytes' ~ '^[1-9][0-9]{0,7}$'
    AND jsonb_typeof(d->'sha256')='string' AND d->>'sha256' ~ '^[a-f0-9]{64}$',false) THEN RAISE EXCEPTION 'Invalid evidence declaration'; END IF;
  IF (d->>'sizeBytes')::bigint>10485760 THEN RAISE EXCEPTION 'Evidence exceeds size limit'; END IF;
  SELECT jsonb_agg(value) INTO sources FROM jsonb_array_elements(owner_definition->'sourceReferences') WHERE value->>'sha256'=d->>'sha256';
  IF sources IS NULL OR (SELECT count(*) FROM (SELECT DISTINCT value->>'title',value->>'url' FROM jsonb_array_elements(sources)) refs)<>1 THEN RAISE EXCEPTION 'Evidence must identify one declared source'; END IF;
  NEW.source_references:=sources; NEW.demo_only:=(owner_definition->>'demoOnly')::boolean;
  IF NEW.demo_only AND NOT EXISTS(SELECT 1 FROM public.legal_entities WHERE organization_id=NEW.organization_id AND id=NEW.legal_entity_id AND policy_status='demo' AND reporting_profile='demo_accrual') THEN RAISE EXCEPTION 'Synthetic evidence requires a demo company'; END IF;
  NEW.created_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER rule_evidence_guard BEFORE INSERT ON rule_evidence_requests FOR EACH ROW EXECUTE FUNCTION app_security.guard_rule_evidence_request();
REVOKE ALL ON FUNCTION app_security.guard_rule_evidence_request() FROM PUBLIC;
