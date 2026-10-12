-- Preserve the same scoped finance-read predicate. Once row scope matches the
-- transaction-local IDs, its permission arguments are constant for this SQL
-- statement. Uncorrelated subqueries produce statement-local InitPlans instead
-- of repeating membership lookups for every journal line. No pooled/session
-- authorization cache, raw-owner grant, write grant or financial data change.
ALTER POLICY journal_scoped_read ON journal_entries USING (
  organization_id::text=current_setting('app.org_id',true)
  AND legal_entity_id::text=current_setting('app.entity_id',true)
  AND (SELECT app_security.finance_setup_scope(
    nullif(current_setting('app.org_id',true),'')::uuid,
    nullif(current_setting('app.entity_id',true),'')::uuid))
  AND (SELECT app_security.can_read_accounts(nullif(current_setting('app.org_id',true),'')::uuid))
);
ALTER POLICY journal_scoped_read ON journal_lines USING (
  organization_id::text=current_setting('app.org_id',true)
  AND legal_entity_id::text=current_setting('app.entity_id',true)
  AND (SELECT app_security.finance_setup_scope(
    nullif(current_setting('app.org_id',true),'')::uuid,
    nullif(current_setting('app.entity_id',true),'')::uuid))
  AND (SELECT app_security.can_read_accounts(nullif(current_setting('app.org_id',true),'')::uuid))
);
