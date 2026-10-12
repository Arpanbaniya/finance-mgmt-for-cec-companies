-- Parenthesize JSON extraction before subtraction: PostgreSQL gives '-' higher
-- precedence than '->'. Preserve the already-applied draft migration unchanged.
DO $$
DECLARE body text;
BEGIN
  body:=pg_get_functiondef('app_security.guard_rule_draft()'::regprocedure);
  body:=replace(body, 'd->''applicability''-ARRAY', '(d->''applicability'')-ARRAY');
  EXECUTE body;
END $$;
