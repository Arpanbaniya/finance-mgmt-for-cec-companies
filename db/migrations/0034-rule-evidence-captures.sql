-- Captured bytes remain quarantined. This is not a scan or a retention hold.
CREATE TABLE rule_evidence_captures (
  document_id uuid PRIMARY KEY, organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL,
  actual_size integer NOT NULL CHECK(actual_size BETWEEN 1 AND 10485760),
  actual_hash text NOT NULL CHECK(actual_hash ~ '^[a-f0-9]{64}$'),
  provider_etag text NOT NULL CHECK(provider_etag ~ '^"[A-Za-z0-9-]{1,200}"$'),
  provider_version_id text CHECK(length(provider_version_id) BETWEEN 1 AND 1024),
  storage_bucket text NOT NULL CHECK(storage_bucket ~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'),
  storage_endpoint text NOT NULL,
  scan_state text NOT NULL DEFAULT 'quarantined' CHECK(scan_state='quarantined'),
  retention_class text NOT NULL DEFAULT 'unconfigured' CHECK(retention_class='unconfigured'),
  deletion_hold boolean NOT NULL DEFAULT false CHECK(NOT deletion_hold),
  uploaded_by text NOT NULL REFERENCES auth_user(id),
  captured_by text NOT NULL REFERENCES auth_user(id), captured_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 2 CHECK(version=2),
  UNIQUE(organization_id,legal_entity_id,document_id),
  FOREIGN KEY(organization_id,legal_entity_id,document_id) REFERENCES rule_evidence_requests(organization_id,legal_entity_id,id)
);
ALTER TABLE rule_evidence_captures ENABLE ROW LEVEL SECURITY;
CREATE POLICY rule_capture_read ON rule_evidence_captures FOR SELECT USING(app_security.finance_setup_scope(organization_id,legal_entity_id) AND app_security.can_read_rules(organization_id));
CREATE POLICY rule_capture_create ON rule_evidence_captures FOR INSERT WITH CHECK(app_security.finance_setup_scope(organization_id,legal_entity_id) AND app_security.can_manage_accounts(organization_id));
CREATE TRIGGER rule_capture_immutable BEFORE UPDATE OR DELETE ON rule_evidence_captures FOR EACH ROW EXECUTE FUNCTION app_security.append_only();
CREATE FUNCTION app_security.guard_rule_evidence_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE request public.rule_evidence_requests%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
  IF NOT app_security.finance_setup_scope(NEW.organization_id,NEW.legal_entity_id) OR NOT app_security.can_manage_accounts(NEW.organization_id)
    OR NEW.captured_by IS DISTINCT FROM current_setting('app.user_id',true) THEN RAISE EXCEPTION 'Invalid capture authority'; END IF;
  SELECT * INTO request FROM public.rule_evidence_requests WHERE organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id AND id=NEW.document_id;
  IF request.id IS NULL OR NEW.actual_hash IS DISTINCT FROM request.declaration->>'sha256'
    OR NEW.actual_size IS DISTINCT FROM (request.declaration->>'sizeBytes')::integer THEN RAISE EXCEPTION 'Capture does not match reservation'; END IF;
  IF request.demo_only AND NOT EXISTS(SELECT 1 FROM public.legal_entities WHERE organization_id=NEW.organization_id AND id=NEW.legal_entity_id AND policy_status='demo' AND reporting_profile='demo_accrual') THEN RAISE EXCEPTION 'Synthetic capture requires a demo company'; END IF;
  -- Actual-byte/storage provenance is the trusted service's responsibility;
  -- SQL can constrain it but cannot contact or scan the object store.
  IF NEW.storage_endpoint !~ '^https?://[^/@?#[:space:]]+$' THEN RAISE EXCEPTION 'Invalid storage origin'; END IF;
  NEW.uploaded_by:=request.created_by; NEW.captured_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER rule_capture_guard BEFORE INSERT ON rule_evidence_captures FOR EACH ROW EXECUTE FUNCTION app_security.guard_rule_evidence_capture();
REVOKE ALL ON FUNCTION app_security.guard_rule_evidence_capture() FROM PUBLIC;
