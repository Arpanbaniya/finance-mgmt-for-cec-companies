-- Keep decimal money as strings even in retained master snapshots.
CREATE OR REPLACE FUNCTION app_security.record_party_version() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  INSERT INTO public.party_versions(organization_id,legal_entity_id,party_id,version,snapshot)
    VALUES(NEW.organization_id,NEW.legal_entity_id,NEW.id,NEW.version,to_jsonb(NEW) || jsonb_build_object('credit_limit',NEW.credit_limit::text));
  RETURN NEW;
END $$;
