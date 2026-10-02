-- Versioned recovery of the existing typed delivery job, not a generic task runner.
ALTER TABLE outbox_events ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN total_attempts integer NOT NULL DEFAULT 0 CHECK(total_attempts BETWEEN 0 AND 12),
  ADD COLUMN retry_count integer NOT NULL DEFAULT 0 CHECK(retry_count BETWEEN 0 AND 3);
ALTER TABLE outbox_events DISABLE TRIGGER outbox_guard;
UPDATE outbox_events SET total_attempts=attempts;
ALTER TABLE outbox_events ENABLE TRIGGER outbox_guard;
CREATE TABLE job_retries (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, legal_entity_id uuid NOT NULL,
  event_id uuid NOT NULL, principal_id text NOT NULL REFERENCES auth_user(id),
  from_version integer NOT NULL CHECK(from_version>0), reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 1000),
  request_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_id,from_version),
  FOREIGN KEY(organization_id,legal_entity_id,event_id) REFERENCES outbox_events(organization_id,legal_entity_id,id)
);
ALTER TABLE job_retries ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_retries_scope ON job_retries USING (
  organization_id::text=current_setting('app.org_id',true) AND legal_entity_id::text=current_setting('app.entity_id',true)
  AND principal_id=current_setting('app.user_id',true) AND app_security.can_entity(organization_id,legal_entity_id)
  AND app_security.can_activate_policy(organization_id)) WITH CHECK (
  organization_id::text=current_setting('app.org_id',true) AND legal_entity_id::text=current_setting('app.entity_id',true)
  AND principal_id=current_setting('app.user_id',true) AND app_security.can_entity(organization_id,legal_entity_id)
  AND app_security.can_activate_policy(organization_id));
CREATE FUNCTION app_security.guard_job_retry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
  IF NEW.organization_id::text IS DISTINCT FROM current_setting('app.org_id',true)
    OR NEW.legal_entity_id::text IS DISTINCT FROM current_setting('app.entity_id',true)
    OR NEW.principal_id IS DISTINCT FROM current_setting('app.user_id',true)
    OR NOT app_security.can_activate_policy(NEW.organization_id)
    OR NOT app_security.can_entity(NEW.organization_id,NEW.legal_entity_id)
    OR NOT EXISTS(SELECT 1 FROM public.outbox_events e JOIN public.approval_policies p
      ON p.id=e.policy_id AND p.organization_id=e.organization_id AND p.legal_entity_id=e.legal_entity_id
      WHERE e.id=NEW.event_id AND e.organization_id=NEW.organization_id AND e.legal_entity_id=NEW.legal_entity_id
      AND e.principal_id=NEW.principal_id AND e.status='failed' AND e.attempts=3 AND e.retry_count<3 AND e.version=NEW.from_version
      AND p.status='active' AND p.version=e.source_version AND p.content_hash=e.source_hash
      AND app_security.policy_alert_recipient_eligible(e.organization_id,e.legal_entity_id,e.recipient_id))
    THEN RAISE EXCEPTION 'Invalid job retry'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER job_retry_guard BEFORE INSERT ON job_retries FOR EACH ROW EXECUTE FUNCTION app_security.guard_job_retry();
CREATE TRIGGER job_retry_append_only BEFORE UPDATE OR DELETE ON job_retries FOR EACH ROW EXECUTE FUNCTION app_security.append_only();
REVOKE ALL ON FUNCTION app_security.guard_job_retry() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_security.guard_outbox() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'pending' OR NEW.attempts<>0 OR NEW.total_attempts<>0 OR NEW.retry_count<>0 OR NEW.version<>1 OR NEW.last_error_code IS NOT NULL
      OR NOT EXISTS(SELECT 1 FROM public.approval_policies WHERE organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id
        AND id=NEW.policy_id AND status='active' AND version=NEW.source_version AND content_hash=NEW.source_hash
        AND activated_by=NEW.principal_id AND created_by=NEW.recipient_id)
      THEN RAISE EXCEPTION 'Invalid outbox source'; END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['status','attempts','available_at','lease_token','lease_until','last_error_code','completed_at','version','updated_at','total_attempts','retry_count'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','attempts','available_at','lease_token','lease_until','last_error_code','completed_at','version','updated_at','total_attempts','retry_count'])
      OR OLD.status IN ('delivered','cancelled') OR NEW.version<>OLD.version OR NEW.total_attempts<>OLD.total_attempts
      THEN RAISE EXCEPTION 'Immutable outbox event'; END IF;
    IF OLD.status='failed' THEN
      IF NEW.status<>'pending' OR OLD.attempts<>3 OR OLD.retry_count>=3 OR NEW.attempts<>0 OR NEW.retry_count<>OLD.retry_count+1
        OR NEW.last_error_code IS NOT NULL OR NEW.available_at>clock_timestamp()
        OR NOT app_security.can_activate_policy(OLD.organization_id)
        OR NOT app_security.policy_alert_recipient_eligible(OLD.organization_id,OLD.legal_entity_id,OLD.recipient_id)
        OR NOT EXISTS(SELECT 1 FROM public.approval_policies WHERE id=OLD.policy_id AND organization_id=OLD.organization_id
          AND legal_entity_id=OLD.legal_entity_id AND status='active' AND version=OLD.source_version AND content_hash=OLD.source_hash)
        OR NOT EXISTS(SELECT 1 FROM public.job_retries WHERE event_id=OLD.id AND organization_id=OLD.organization_id
          AND legal_entity_id=OLD.legal_entity_id AND principal_id=current_setting('app.user_id',true) AND from_version=OLD.version)
        THEN RAISE EXCEPTION 'Invalid manual job retry'; END IF;
    ELSE
      IF NEW.retry_count<>OLD.retry_count THEN RAISE EXCEPTION 'Immutable retry count'; END IF;
      IF NEW.status='leased' THEN
        IF NOT (OLD.status='pending' AND OLD.available_at<=clock_timestamp() OR OLD.status='leased' AND OLD.lease_until<=clock_timestamp())
          OR OLD.attempts>=3 OR NEW.attempts<>OLD.attempts+1 OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token
          OR NEW.lease_until<=clock_timestamp() OR NEW.lease_until>clock_timestamp()+interval '61 seconds'
          THEN RAISE EXCEPTION 'Invalid outbox lease'; END IF;
        NEW.total_attempts:=OLD.total_attempts+1;
      ELSIF NEW.status='failed' AND OLD.attempts=3 AND OLD.status='leased' AND OLD.lease_until<=clock_timestamp() THEN
        IF NEW.attempts<>OLD.attempts OR NEW.last_error_code IS DISTINCT FROM 'ATTEMPTS_EXHAUSTED' THEN RAISE EXCEPTION 'Invalid exhaustion'; END IF;
      ELSE
        IF OLD.status<>'leased' OR OLD.lease_until<=clock_timestamp() OR NEW.attempts<>OLD.attempts
          OR NEW.status NOT IN ('pending','delivered','cancelled','failed') THEN RAISE EXCEPTION 'Invalid outbox completion'; END IF;
        IF NEW.status='delivered' AND NOT EXISTS(SELECT 1 FROM public.alerts WHERE event_id=OLD.id AND effect_key='policy_activation_alert') THEN RAISE EXCEPTION 'Missing delivery effect'; END IF;
        IF NEW.status='pending' AND (NEW.attempts>=3 OR NEW.available_at<=clock_timestamp() OR NEW.last_error_code IS DISTINCT FROM 'DELIVERY_FAILED') THEN RAISE EXCEPTION 'Invalid delivery retry'; END IF;
        IF NEW.status='failed' AND NEW.attempts<>3 THEN RAISE EXCEPTION 'Premature exhaustion'; END IF;
      END IF;
    END IF;
    NEW.version:=OLD.version+1;
    NEW.updated_at:=clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
