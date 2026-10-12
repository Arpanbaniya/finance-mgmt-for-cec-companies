-- Add presentation choices only; never update retained account versions.
ALTER TABLE accounts ADD COLUMN profit_loss_category text NOT NULL DEFAULT 'unclassified',
  ADD COLUMN cost_behavior text NOT NULL DEFAULT 'unclassified';
ALTER TABLE accounts ADD CONSTRAINT accounts_profit_loss_category CHECK (
  profit_loss_category='unclassified'
  OR (type IN ('asset','liability','equity') AND profit_loss_category='not_applicable')
  OR (type='revenue' AND profit_loss_category IN ('revenue','other_income'))
  OR (type='expense' AND profit_loss_category IN ('direct_cost','operating_expense','finance_cost','income_tax'))
), ADD CONSTRAINT accounts_cost_behavior CHECK (
  cost_behavior IN ('unclassified','not_applicable')
  OR (profit_loss_category IN ('direct_cost','operating_expense') AND cost_behavior IN ('fixed','variable'))
);

-- Preserve the complete existing guard, adding only the two permitted mapping
-- fields to an ordinary versioned edit. Archive still cannot change mappings.
CREATE OR REPLACE FUNCTION app_security.guard_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
  IF NEW.organization_id::text IS DISTINCT FROM current_setting('app.org_id',true)
    OR NEW.legal_entity_id::text IS DISTINCT FROM current_setting('app.entity_id',true)
    OR NOT app_security.can_manage_accounts(NEW.organization_id) OR NOT app_security.can_entity(NEW.organization_id,NEW.legal_entity_id)
    OR NEW.updated_by IS DISTINCT FROM current_setting('app.user_id',true) THEN RAISE EXCEPTION 'Invalid account authority'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NOT NEW.active OR NEW.created_by IS DISTINCT FROM current_setting('app.user_id',true) THEN RAISE EXCEPTION 'Invalid account creation'; END IF;
    NEW.created_at:=clock_timestamp();
  ELSE
    IF NOT OLD.active OR NEW.version<>OLD.version+1
      OR (to_jsonb(NEW)-ARRAY['name','parent_id','report_section','cash_flow_category','profit_loss_category','cost_behavior','active','version','updated_by','updated_at','archived_by','archived_at','archive_reason'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['name','parent_id','report_section','cash_flow_category','profit_loss_category','cost_behavior','active','version','updated_by','updated_at','archived_by','archived_at','archive_reason'])
      THEN RAISE EXCEPTION 'Immutable account identity or classification'; END IF;
    IF NOT NEW.active THEN
      IF NEW.archived_by IS DISTINCT FROM current_setting('app.user_id',true) OR NEW.archived_at IS NULL
        OR (to_jsonb(NEW)-ARRAY['active','version','updated_by','updated_at','archived_by','archived_at','archive_reason'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['active','version','updated_by','updated_at','archived_by','archived_at','archive_reason'])
        OR EXISTS(SELECT 1 FROM public.accounts WHERE organization_id=OLD.organization_id AND legal_entity_id=OLD.legal_entity_id AND parent_id=OLD.id AND active)
        THEN RAISE EXCEPTION 'Account has active dependencies or invalid archive'; END IF;
      NEW.archived_at:=clock_timestamp();
    END IF;
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM public.accounts WHERE id=NEW.parent_id AND organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id
      AND active AND type=NEW.type AND NOT is_control) THEN RAISE EXCEPTION 'Invalid account parent'; END IF;
    IF EXISTS(WITH RECURSIVE ancestors AS (
      SELECT id,parent_id FROM public.accounts WHERE id=NEW.parent_id AND organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id
      UNION SELECT a.id,a.parent_id FROM public.accounts a JOIN ancestors p ON a.id=p.parent_id
        WHERE a.organization_id=NEW.organization_id AND a.legal_entity_id=NEW.legal_entity_id
    ) SELECT 1 FROM ancestors WHERE id=NEW.id) THEN RAISE EXCEPTION 'Account hierarchy cycle'; END IF;
  END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_security.guard_account() FROM PUBLIC;
