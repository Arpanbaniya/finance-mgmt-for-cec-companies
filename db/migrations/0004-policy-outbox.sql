-- Typed, local in-app delivery only. No provider payloads or global worker role.
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind='approval_policy.activated'),
  policy_id uuid NOT NULL, source_version integer NOT NULL CHECK(source_version=2),
  source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
  principal_id text NOT NULL REFERENCES auth_user(id), recipient_id text NOT NULL REFERENCES auth_user(id),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','delivered','cancelled','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  available_at timestamptz NOT NULL DEFAULT now(), lease_token uuid, lease_until timestamptz,
  last_error_code text CHECK(last_error_code IN ('DELIVERY_FAILED','RECIPIENT_UNAVAILABLE','SOURCE_CHANGED','ATTEMPTS_EXHAUSTED')),
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  UNIQUE(organization_id,legal_entity_id,id),
  UNIQUE(organization_id,legal_entity_id,kind,policy_id,source_version),
  FOREIGN KEY(organization_id,legal_entity_id,policy_id) REFERENCES approval_policies(organization_id,legal_entity_id,id),
  CHECK((status='leased' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR (status<>'leased' AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK((status IN ('delivered','cancelled','failed'))=(completed_at IS NOT NULL))
);
CREATE INDEX outbox_due ON outbox_events(organization_id,legal_entity_id,principal_id,available_at,id) WHERE status IN ('pending','leased');
CREATE TABLE alerts (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL,
  event_id uuid NOT NULL, effect_key text NOT NULL CHECK(effect_key='policy_activation_alert'),
  recipient_id text NOT NULL REFERENCES auth_user(id), policy_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), acknowledged_at timestamptz, acknowledgement_reason text,
  version integer NOT NULL DEFAULT 1,
  UNIQUE(event_id,effect_key),
  FOREIGN KEY(organization_id,legal_entity_id,event_id) REFERENCES outbox_events(organization_id,legal_entity_id,id),
  FOREIGN KEY(organization_id,legal_entity_id,policy_id) REFERENCES approval_policies(organization_id,legal_entity_id,id),
  CHECK((version=1 AND acknowledged_at IS NULL AND acknowledgement_reason IS NULL) OR (version=2 AND acknowledged_at IS NOT NULL AND length(btrim(acknowledgement_reason)) BETWEEN 3 AND 1000))
);
CREATE INDEX alerts_recipient ON alerts(organization_id,legal_entity_id,recipient_id,id);

CREATE FUNCTION app_security.policy_alert_recipient_eligible(org uuid, entity uuid, recipient text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT org::text=current_setting('app.org_id',true) AND entity::text=current_setting('app.entity_id',true)
    AND (recipient=current_setting('app.user_id',true) OR app_security.can_activate_policy(org))
    AND EXISTS(SELECT 1 FROM public.memberships WHERE organization_id=org AND user_id=recipient AND active
      AND allowed_entity_ids ? entity::text AND roles ?| ARRAY['organization_admin','finance_manager','auditor','policy_reviewer'])
$$;
REVOKE ALL ON FUNCTION app_security.policy_alert_recipient_eligible(uuid,uuid,text) FROM PUBLIC;
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY outbox_scope ON outbox_events USING (
  organization_id::text=current_setting('app.org_id',true) AND legal_entity_id::text=current_setting('app.entity_id',true)
  AND principal_id=current_setting('app.user_id',true) AND app_security.can_entity(organization_id,legal_entity_id)
  AND app_security.can_activate_policy(organization_id)) WITH CHECK (
  organization_id::text=current_setting('app.org_id',true) AND legal_entity_id::text=current_setting('app.entity_id',true)
  AND principal_id=current_setting('app.user_id',true) AND app_security.can_entity(organization_id,legal_entity_id)
  AND app_security.can_activate_policy(organization_id));
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY alerts_read ON alerts FOR SELECT USING (
  recipient_id=current_setting('app.user_id',true) AND app_security.policy_alert_recipient_eligible(organization_id,legal_entity_id,recipient_id));
CREATE POLICY alerts_insert ON alerts FOR INSERT WITH CHECK (
  organization_id::text=current_setting('app.org_id',true) AND legal_entity_id::text=current_setting('app.entity_id',true)
  AND app_security.can_activate_policy(organization_id) AND app_security.can_entity(organization_id,legal_entity_id));
CREATE POLICY alerts_ack ON alerts FOR UPDATE USING (
  recipient_id=current_setting('app.user_id',true) AND app_security.policy_alert_recipient_eligible(organization_id,legal_entity_id,recipient_id)) WITH CHECK (
  recipient_id=current_setting('app.user_id',true) AND app_security.policy_alert_recipient_eligible(organization_id,legal_entity_id,recipient_id));

CREATE FUNCTION app_security.guard_outbox() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'pending' OR NEW.attempts<>0 OR NEW.last_error_code IS NOT NULL
      OR NOT EXISTS(SELECT 1 FROM public.approval_policies WHERE organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id
        AND id=NEW.policy_id AND status='active' AND version=NEW.source_version AND content_hash=NEW.source_hash
        AND activated_by=NEW.principal_id AND created_by=NEW.recipient_id)
      THEN RAISE EXCEPTION 'Invalid outbox source'; END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['status','attempts','available_at','lease_token','lease_until','last_error_code','completed_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','attempts','available_at','lease_token','lease_until','last_error_code','completed_at'])
      OR OLD.status IN ('delivered','cancelled','failed') THEN RAISE EXCEPTION 'Immutable outbox event'; END IF;
    IF NEW.status='leased' THEN
      IF NOT (OLD.status='pending' AND OLD.available_at<=clock_timestamp() OR OLD.status='leased' AND OLD.lease_until<=clock_timestamp())
        OR OLD.attempts>=3 OR NEW.attempts<>OLD.attempts+1 OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token
        OR NEW.lease_until<=clock_timestamp() OR NEW.lease_until>clock_timestamp()+interval '61 seconds'
        THEN RAISE EXCEPTION 'Invalid outbox lease'; END IF;
    ELSIF NEW.status='failed' AND OLD.attempts=3 AND OLD.status='leased' AND OLD.lease_until<=clock_timestamp() THEN
      IF NEW.attempts<>OLD.attempts OR NEW.last_error_code IS DISTINCT FROM 'ATTEMPTS_EXHAUSTED' THEN RAISE EXCEPTION 'Invalid exhaustion'; END IF;
    ELSE
      IF OLD.status<>'leased' OR OLD.lease_until<=clock_timestamp() OR NEW.attempts<>OLD.attempts
        OR NEW.status NOT IN ('pending','delivered','cancelled','failed') THEN RAISE EXCEPTION 'Invalid outbox completion'; END IF;
      IF NEW.status='delivered' AND NOT EXISTS(SELECT 1 FROM public.alerts WHERE event_id=OLD.id AND effect_key='policy_activation_alert') THEN RAISE EXCEPTION 'Missing delivery effect'; END IF;
      IF NEW.status='pending' AND (NEW.attempts>=3 OR NEW.available_at<=clock_timestamp() OR NEW.last_error_code IS DISTINCT FROM 'DELIVERY_FAILED') THEN RAISE EXCEPTION 'Invalid delivery retry'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_guard BEFORE INSERT OR UPDATE ON outbox_events FOR EACH ROW EXECUTE FUNCTION app_security.guard_outbox();
CREATE FUNCTION app_security.guard_alert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NEW.acknowledged_at IS NOT NULL OR NEW.acknowledgement_reason IS NOT NULL
      OR NOT app_security.policy_alert_recipient_eligible(NEW.organization_id,NEW.legal_entity_id,NEW.recipient_id)
      OR NOT EXISTS(SELECT 1 FROM public.outbox_events e JOIN public.approval_policies p ON p.id=e.policy_id AND p.organization_id=e.organization_id AND p.legal_entity_id=e.legal_entity_id
        WHERE e.id=NEW.event_id AND e.organization_id=NEW.organization_id AND e.legal_entity_id=NEW.legal_entity_id AND e.recipient_id=NEW.recipient_id AND e.policy_id=NEW.policy_id
          AND e.principal_id=current_setting('app.user_id',true) AND e.status='leased' AND e.lease_until>clock_timestamp()
          AND p.status='active' AND p.version=e.source_version AND p.content_hash=e.source_hash)
      THEN RAISE EXCEPTION 'Invalid alert source'; END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['acknowledged_at','acknowledgement_reason','version']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['acknowledged_at','acknowledgement_reason','version'])
      OR OLD.version<>1 OR NEW.version<>2 OR NEW.acknowledged_at IS NULL OR NEW.recipient_id IS DISTINCT FROM current_setting('app.user_id',true)
      THEN RAISE EXCEPTION 'Immutable alert'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER alert_guard BEFORE INSERT OR UPDATE ON alerts FOR EACH ROW EXECUTE FUNCTION app_security.guard_alert();
REVOKE ALL ON FUNCTION app_security.guard_outbox(),app_security.guard_alert() FROM PUBLIC;
