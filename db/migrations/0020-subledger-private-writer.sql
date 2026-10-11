-- An owner-only kernel seam for later persisted approved-source adapters.
-- It is NOT an invoice/payment creation API or an approval decision.
CREATE FUNCTION app_security.write_subledger_source(org uuid,entity uuid,source uuid,body jsonb,request text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.subledger_sources; prior public.subledger_sources; target public.subledger_open_items; capacity public.subledger_settlements;
  original public.subledger_allocations; original_source public.subledger_sources; debit_master public.accounts; credit_master public.accounts;
  kind text; side text; actor text:=current_setting('app.user_id',true); party uuid; amount numeric; posting date; document date;
  debit_id uuid; credit_id uuid; debit_v integer; credit_v integer; debit_control text; credit_control text; debit_type text; credit_type text;
  receipt public.document_numbers; period_row public.fiscal_periods; allocation jsonb; event_id uuid; item_id uuid; held_journal uuid;
BEGIN
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  IF NOT app_security.finance_setup_scope(org,entity) OR NOT app_security.can_manage_accounts(org) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF source IS NULL OR request IS NULL OR length(btrim(request)) NOT BETWEEN 1 AND 200 OR jsonb_typeof(body) IS DISTINCT FROM 'object'
    OR jsonb_typeof(body->'kind') IS DISTINCT FROM 'string' OR jsonb_typeof(body->'postingDate') IS DISTINCT FROM 'string' OR jsonb_typeof(body->'documentDate') IS DISTINCT FROM 'string'
    OR (body->>'postingDate') !~ '^\d{4}-\d{2}-\d{2}$' OR (body->>'documentDate') !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
  kind:=body->>'kind'; posting:=(body->>'postingDate')::date; document:=(body->>'documentDate')::date;
  IF posting NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' OR document NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
  SELECT * INTO prior FROM public.subledger_sources WHERE id=source;
  IF prior.id IS NOT NULL THEN
    IF prior.organization_id<>org OR prior.legal_entity_id<>entity THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
    IF prior.body IS DISTINCT FROM body THEN RAISE EXCEPTION 'SOURCE_CONFLICT'; END IF; RETURN prior.journal_id;
  END IF;
  IF kind IN ('ar_item','ap_item','ar_deposit','ap_advance','ar_direct','ap_direct') THEN
    IF NOT body ?& ARRAY['partyId','amount','controlAccountId','counterAccountId'] OR body-ARRAY['kind','postingDate','documentDate','partyId','amount','controlAccountId','counterAccountId','dueDate','allocations']<>'{}'::jsonb
      OR jsonb_typeof(body->'amount') IS DISTINCT FROM 'string' OR (body->>'amount') !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,2})?$'
      OR jsonb_typeof(body->'partyId') IS DISTINCT FROM 'string' OR jsonb_typeof(body->'controlAccountId') IS DISTINCT FROM 'string' OR jsonb_typeof(body->'counterAccountId') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
    party:=(body->>'partyId')::uuid; amount:=(body->>'amount')::numeric;
    side:=CASE WHEN kind LIKE 'ar_%' THEN 'ar' ELSE 'ap' END;
    IF kind IN ('ar_item','ap_item') THEN
      IF body ? 'allocations' OR jsonb_typeof(body->'dueDate') IS DISTINCT FROM 'string' OR (body->>'dueDate') !~ '^\d{4}-\d{2}-\d{2}$' OR (body->>'dueDate')::date NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
    ELSE
      IF body ? 'dueDate' THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
      IF kind IN ('ar_direct','ap_direct') THEN
        IF jsonb_typeof(body->'allocations') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
        IF jsonb_array_length(body->'allocations') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
      ELSIF body ? 'allocations' THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
    END IF;
    IF kind IN ('ar_item','ap_advance','ap_direct') THEN debit_id:=(body->>'controlAccountId')::uuid; credit_id:=(body->>'counterAccountId')::uuid;
    ELSE debit_id:=(body->>'counterAccountId')::uuid; credit_id:=(body->>'controlAccountId')::uuid; END IF;
    CASE kind
      WHEN 'ar_item' THEN debit_control:='ar'; credit_type:='revenue';
      WHEN 'ap_item' THEN credit_control:='ap'; debit_type:='expense';
      WHEN 'ar_deposit' THEN debit_control:='cash'; credit_control:='customer_deposits';
      WHEN 'ap_advance' THEN debit_control:='supplier_advances'; credit_control:='cash';
      WHEN 'ar_direct' THEN debit_control:='cash'; credit_control:='ar';
      WHEN 'ap_direct' THEN debit_control:='ap'; credit_control:='cash';
    END CASE;
  ELSIF kind='application' THEN
    IF NOT body ?& ARRAY['settlementId','openItemId','amount'] OR body-ARRAY['kind','postingDate','documentDate','settlementId','openItemId','amount']<>'{}'::jsonb
      OR jsonb_typeof(body->'amount') IS DISTINCT FROM 'string' OR (body->>'amount') !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,2})?$'
      OR jsonb_typeof(body->'settlementId') IS DISTINCT FROM 'string' OR jsonb_typeof(body->'openItemId') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
    SELECT * INTO capacity FROM public.subledger_settlements WHERE id=(body->>'settlementId')::uuid AND organization_id=org AND legal_entity_id=entity FOR UPDATE;
    SELECT * INTO target FROM public.subledger_open_items WHERE id=(body->>'openItemId')::uuid AND organization_id=org AND legal_entity_id=entity FOR UPDATE;
    IF capacity.id IS NULL OR target.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
    IF capacity.party_id<>target.party_id OR capacity.side<>target.side THEN RAISE EXCEPTION 'SUBLEDGER_SCOPE_MISMATCH'; END IF;
    IF capacity.mode<>'on_account' THEN RAISE EXCEPTION 'SOURCE_ALREADY_CONSUMED'; END IF;
    party:=target.party_id; amount:=(body->>'amount')::numeric; side:=target.side;
    SELECT account_id INTO debit_id FROM public.journal_lines WHERE journal_id=CASE side WHEN 'ar' THEN capacity.journal_id ELSE target.journal_id END AND ordinal=CASE side WHEN 'ar' THEN capacity.ordinal ELSE target.ordinal END;
    SELECT account_id INTO credit_id FROM public.journal_lines WHERE journal_id=CASE side WHEN 'ar' THEN target.journal_id ELSE capacity.journal_id END AND ordinal=CASE side WHEN 'ar' THEN target.ordinal ELSE capacity.ordinal END;
    debit_control:=CASE side WHEN 'ar' THEN 'customer_deposits' ELSE 'ap' END; credit_control:=CASE side WHEN 'ar' THEN 'ar' ELSE 'supplier_advances' END;
  ELSIF kind='allocation_reverse' THEN
    IF NOT body ?& ARRAY['reversalOf','reason'] OR body-ARRAY['kind','postingDate','documentDate','reversalOf','reason']<>'{}'::jsonb
      OR jsonb_typeof(body->'reversalOf') IS DISTINCT FROM 'string' OR jsonb_typeof(body->'reason') IS DISTINCT FROM 'string' OR length(btrim(body->>'reason')) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
    SELECT * INTO original FROM public.subledger_allocations WHERE id=(body->>'reversalOf')::uuid AND organization_id=org AND legal_entity_id=entity FOR UPDATE;
    IF original.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
    IF original.reversal_of IS NOT NULL THEN RAISE EXCEPTION 'INVALID_STATE'; END IF;
    SELECT * INTO original_source FROM public.subledger_sources WHERE id=original.source_id;
    IF original_source.kind<>'application' THEN RAISE EXCEPTION 'FEATURE_NOT_ENABLED'; END IF;
    IF EXISTS(SELECT 1 FROM public.subledger_allocations WHERE reversal_of=original.id) THEN RAISE EXCEPTION 'ALREADY_REVERSED'; END IF;
    SELECT * INTO capacity FROM public.subledger_settlements WHERE id=original.settlement_id FOR UPDATE;
    SELECT * INTO target FROM public.subledger_open_items WHERE id=original.open_item_id FOR UPDATE;
    party:=target.party_id; side:=target.side; amount:=original.amount;
    debit_id:=original_source.credit_account_id; credit_id:=original_source.debit_account_id; debit_v:=original_source.credit_version; credit_v:=original_source.debit_version;
    debit_control:=CASE side WHEN 'ar' THEN 'ar' ELSE 'supplier_advances' END; credit_control:=CASE side WHEN 'ar' THEN 'customer_deposits' ELSE 'ap' END;
  ELSE RAISE EXCEPTION 'FEATURE_NOT_ENABLED'; END IF;
  IF amount IS NULL OR amount<=0 OR amount>999999999999999999.99 OR debit_id=credit_id THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
  PERFORM 1 FROM public.accounts WHERE organization_id=org AND legal_entity_id=entity AND id IN (debit_id,credit_id) ORDER BY id FOR UPDATE;
  SELECT * INTO debit_master FROM public.accounts WHERE id=debit_id AND organization_id=org AND legal_entity_id=entity;
  SELECT * INTO credit_master FROM public.accounts WHERE id=credit_id AND organization_id=org AND legal_entity_id=entity;
  IF debit_master.id IS NULL OR credit_master.id IS NULL OR NOT debit_master.active OR NOT credit_master.active
    OR debit_master.control_type IS DISTINCT FROM debit_control OR credit_master.control_type IS DISTINCT FROM credit_control
    OR (debit_type IS NOT NULL AND debit_master.type<>debit_type) OR (credit_type IS NOT NULL AND credit_master.type<>credit_type) THEN RAISE EXCEPTION 'ACCOUNT_UNAVAILABLE'; END IF;
  debit_v:=coalesce(debit_v,debit_master.version); credit_v:=coalesce(credit_v,credit_master.version);
  SELECT * INTO period_row FROM public.fiscal_periods WHERE organization_id=org AND legal_entity_id=entity AND start_date<=posting AND posting<end_date_exclusive FOR UPDATE;
  IF period_row.id IS NULL OR period_row.state<>'open' THEN RAISE EXCEPTION 'PERIOD_CLOSED'; END IF;
  INSERT INTO public.subledger_sources(id,organization_id,legal_entity_id,party_id,kind,journal_id,body,amount,debit_account_id,debit_version,credit_account_id,credit_version,posting_date,document_date,recorded_at,created_transaction,created_by)
    VALUES(source,org,entity,party,kind,gen_random_uuid(),body,amount,debit_id,debit_v,credit_id,credit_v,posting,document,clock_timestamp(),pg_current_xact_id(),actor) RETURNING * INTO s;
  SELECT * INTO receipt FROM app_security.allocate_document_number(org,entity,CASE kind WHEN 'ar_item' THEN 'invoice' WHEN 'ap_item' THEN 'bill' ELSE 'settlement' END,source,CASE kind WHEN 'allocation_reverse' THEN 'reverse' ELSE 'post' END,posting);
  INSERT INTO public.journal_entries(id,organization_id,legal_entity_id,source_type,source_id,event_kind,status,posting_date,document_date,description,currency,number_id,number,fiscal_period_id,payload,total_debit,total_credit,created_by)
    VALUES(s.journal_id,org,entity,receipt.document_type,source,receipt.event_kind,'posted',posting,document,'Private subledger source primitive','NPR',receipt.id,receipt.number,period_row.id,body,amount,amount,actor);
  INSERT INTO public.journal_lines(organization_id,legal_entity_id,journal_id,ordinal,account_id,account_version,debit,credit)
    VALUES(org,entity,s.journal_id,1,debit_id,debit_v,amount,0),(org,entity,s.journal_id,2,credit_id,credit_v,0,amount);
  IF kind IN ('ar_item','ap_item') THEN
    INSERT INTO public.subledger_open_items VALUES(gen_random_uuid(),org,entity,party,side,source,s.journal_id,CASE side WHEN 'ar' THEN 1 ELSE 2 END,amount,(body->>'dueDate')::date,posting,s.recorded_at);
  ELSIF kind IN ('ar_deposit','ap_advance','ar_direct','ap_direct') THEN
    INSERT INTO public.subledger_settlements VALUES(source,org,entity,party,side,CASE WHEN kind IN ('ar_direct','ap_direct') THEN 'direct' ELSE 'on_account' END,source,s.journal_id,CASE side WHEN 'ar' THEN 2 ELSE 1 END,amount,posting,s.recorded_at);
    IF kind IN ('ar_direct','ap_direct') THEN
      PERFORM 1 FROM public.subledger_open_items WHERE organization_id=org AND legal_entity_id=entity AND id IN (SELECT (value->>'openItemId')::uuid FROM jsonb_array_elements(body->'allocations')) ORDER BY id FOR UPDATE;
      FOR allocation IN SELECT value FROM jsonb_array_elements(body->'allocations') ORDER BY value->>'openItemId' LOOP
        IF jsonb_typeof(allocation) IS DISTINCT FROM 'object' OR NOT allocation ?& ARRAY['openItemId','amount'] OR allocation-ARRAY['openItemId','amount']<>'{}'::jsonb OR jsonb_typeof(allocation->'openItemId') IS DISTINCT FROM 'string'
          OR jsonb_typeof(allocation->'amount') IS DISTINCT FROM 'string' OR (allocation->>'amount') !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,2})?$' THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
        SELECT * INTO target FROM public.subledger_open_items WHERE id=(allocation->>'openItemId')::uuid AND organization_id=org AND legal_entity_id=entity;
        IF target.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.journal_lines WHERE journal_id=target.journal_id AND ordinal=target.ordinal AND account_id=(body->>'controlAccountId')::uuid) THEN RAISE EXCEPTION 'SUBLEDGER_LINK_MISMATCH'; END IF;
        event_id:=gen_random_uuid();
        INSERT INTO public.subledger_allocations VALUES(event_id,org,entity,source,source,target.id,(allocation->>'amount')::numeric,NULL,posting,s.recorded_at,s.journal_id);
      END LOOP;
    END IF;
  ELSE
    event_id:=gen_random_uuid();
    INSERT INTO public.subledger_allocations VALUES(event_id,org,entity,source,capacity.id,target.id,amount,CASE kind WHEN 'allocation_reverse' THEN original.id END,posting,s.recorded_at,s.journal_id);
    IF kind='allocation_reverse' THEN
      INSERT INTO public.journal_reversal_hold_releases SELECT h.organization_id,h.legal_entity_id,h.journal_id,h.dependency_type,h.dependency_id,source FROM public.journal_reversal_holds h WHERE h.organization_id=org AND h.legal_entity_id=entity AND h.dependency_type='allocation' AND h.dependency_id=original.id;
    END IF;
  END IF;
  -- Every active allocation protects all of its journal dependencies. Reversal
  -- releases those holds by new records, never by deleting the original holds.
  FOR event_id,item_id IN SELECT id,open_item_id FROM public.subledger_allocations WHERE source_id=source AND reversal_of IS NULL LOOP
    SELECT * INTO target FROM public.subledger_open_items WHERE id=item_id;
    SELECT c.* INTO capacity FROM public.subledger_settlements c JOIN public.subledger_allocations a ON a.settlement_id=c.id WHERE a.id=event_id;
    FOR held_journal IN SELECT DISTINCT unnest(ARRAY[target.journal_id,capacity.journal_id,s.journal_id]) LOOP
      INSERT INTO public.journal_reversal_holds VALUES(org,entity,held_journal,'allocation',event_id,'Active source-linked allocation');
    END LOOP;
  END LOOP;
  INSERT INTO public.audit_events(id,organization_id,legal_entity_id,actor_id,action,target_id,request_id) VALUES(gen_random_uuid(),org,entity,actor,'subledger.internal_posted',source,request);
  INSERT INTO public.subledger_events VALUES(source,org,entity,s.journal_id,'subledger.posted',s.recorded_at);
  RETURN s.journal_id;
END $$;
REVOKE ALL ON FUNCTION app_security.write_subledger_source(uuid,uuid,uuid,jsonb,text) FROM PUBLIC;
