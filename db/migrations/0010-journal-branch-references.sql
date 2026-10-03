-- Preserve scoped branch references after insertion, not just at validation time.
ALTER TABLE branches ADD CONSTRAINT branches_company_identity UNIQUE(organization_id,legal_entity_id,id);
ALTER TABLE journal_lines ADD CONSTRAINT journal_branch_scope
  FOREIGN KEY(organization_id,legal_entity_id,branch_id) REFERENCES branches(organization_id,legal_entity_id,id);
