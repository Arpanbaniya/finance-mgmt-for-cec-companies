CREATE FUNCTION app_security.guard_posted_manual_journal() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.status='posted' THEN RAISE EXCEPTION 'Posted journal source is immutable'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_security.guard_posted_manual_journal() FROM PUBLIC;
CREATE TRIGGER posted_manual_journal_immutable BEFORE UPDATE ON manual_journal_drafts FOR EACH ROW EXECUTE FUNCTION app_security.guard_posted_manual_journal();
