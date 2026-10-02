-- ON CONFLICT needs existing-row visibility. Do not broaden recipient-only
-- SELECT policies to give a delivery principal access to private alerts.
CREATE FUNCTION app_security.emit_policy_alert(event uuid, token uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.outbox_events;
BEGIN
  IF nullif(current_setting('app.org_id',true),'') IS NULL OR nullif(current_setting('app.entity_id',true),'') IS NULL THEN RAISE EXCEPTION 'Missing delivery scope'; END IF;
  PERFORM 1 FROM public.organizations WHERE id::text=current_setting('app.org_id',true) FOR UPDATE;
  SELECT * INTO e FROM public.outbox_events WHERE id=event
    AND organization_id::text=current_setting('app.org_id',true) AND legal_entity_id::text=current_setting('app.entity_id',true)
    AND principal_id=current_setting('app.user_id',true) AND status='leased' AND lease_token=token AND lease_until>clock_timestamp() FOR UPDATE;
  IF NOT FOUND OR NOT app_security.can_activate_policy(e.organization_id) OR NOT app_security.can_entity(e.organization_id,e.legal_entity_id)
    OR NOT app_security.policy_alert_recipient_eligible(e.organization_id,e.legal_entity_id,e.recipient_id)
    OR NOT EXISTS(SELECT 1 FROM public.approval_policies WHERE organization_id=e.organization_id AND legal_entity_id=e.legal_entity_id
      AND id=e.policy_id AND status='active' AND version=e.source_version AND content_hash=e.source_hash)
    THEN RAISE EXCEPTION 'Delivery authority or source is unavailable'; END IF;
  INSERT INTO public.alerts(id,organization_id,legal_entity_id,event_id,effect_key,recipient_id,policy_id)
    VALUES(gen_random_uuid(),e.organization_id,e.legal_entity_id,e.id,'policy_activation_alert',e.recipient_id,e.policy_id)
    ON CONFLICT(event_id,effect_key) DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION app_security.emit_policy_alert(uuid,uuid) FROM PUBLIC;
