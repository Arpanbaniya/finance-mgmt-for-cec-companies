-- For each knowledge prefix, sum by business date then check running balances.
-- This preserves every two-dimensional cutoff without a date×time×event join.
CREATE FUNCTION app_security.allocation_rectangles_within_limits(org uuid,entity uuid,target uuid,settlement uuid,target_max numeric,capacity_max numeric) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  WITH e AS MATERIALIZED (
    SELECT 'target' AS book,effective_date,recorded_at,CASE WHEN reversal_of IS NULL THEN amount ELSE -amount END AS amount,target_max AS maximum
      FROM public.subledger_allocations WHERE organization_id=org AND legal_entity_id=entity AND open_item_id=target
    UNION ALL
    SELECT 'capacity',effective_date,recorded_at,CASE WHEN reversal_of IS NULL THEN amount ELSE -amount END,capacity_max
      FROM public.subledger_allocations WHERE organization_id=org AND legal_entity_id=entity AND settlement_id=settlement
  ), k AS (SELECT DISTINCT book,recorded_at FROM e), daily AS (
    SELECT e.book,k.recorded_at AS known_at,e.effective_date,sum(e.amount) AS delta,max(e.maximum) AS maximum
      FROM k JOIN e ON e.book=k.book AND e.recorded_at<=k.recorded_at GROUP BY e.book,k.recorded_at,e.effective_date
  ), balances AS (
    SELECT maximum,sum(delta) OVER (PARTITION BY book,known_at ORDER BY effective_date ROWS UNBOUNDED PRECEDING) AS amount FROM daily
  ) SELECT NOT EXISTS(SELECT 1 FROM balances WHERE amount<0 OR amount>maximum);
$$;
CREATE OR REPLACE FUNCTION app_security.check_allocation_balances() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE capacity numeric; target_amount numeric;
BEGIN
  SELECT amount INTO STRICT capacity FROM public.subledger_settlements WHERE id=NEW.settlement_id AND organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id;
  SELECT amount INTO STRICT target_amount FROM public.subledger_open_items WHERE id=NEW.open_item_id AND organization_id=NEW.organization_id AND legal_entity_id=NEW.legal_entity_id;
  IF NOT app_security.allocation_rectangles_within_limits(NEW.organization_id,NEW.legal_entity_id,NEW.open_item_id,NEW.settlement_id,target_amount,capacity) THEN RAISE EXCEPTION 'OVER_ALLOCATION'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app_security.allocation_rectangles_within_limits(uuid,uuid,uuid,uuid,numeric,numeric) FROM PUBLIC;
