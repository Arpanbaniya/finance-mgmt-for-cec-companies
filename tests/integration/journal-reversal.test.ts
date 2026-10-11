import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, expect, it } from "vitest";
import { databasePool } from "@/db/client";
import { withScope } from "@/features/identity/scope";
import { createAccount, patchAccount } from "@/features/accounting/accounts-service";
import { createFiscalYear } from "@/features/accounting/setup-service";
import { createPolicy, activatePolicy } from "@/features/approvals/service";
import { createJournal, patchJournal, cancelJournal, getJournal, submitJournal, approveJournal, postJournal, reverseJournal } from "@/features/accounting/journal-service";
config({ path: ".env.local", quiet: true });
const org=randomUUID(),entity=randomUUID(),otherEntity=randomUUID(),maker=`reversal-${randomUUID()}`,finance=`reversal-${randomUUID()}`,checker=`reversal-${randomUUID()}`,second=`reversal-${randomUUID()}`,reader=`reversal-${randomUUID()}`;
const users=[maker,finance,checker,second,reader],admin=new Pool({connectionString:process.env.MIGRATION_DATABASE_URL});
let expense="",equity="",period="",reversalPeriod="";
const body=(amount="100.00")=>({postingDate:"2026-10-10",documentDate:"2026-10-09",description:"Fictional manual adjustment",lines:[{accountId:expense,debit:amount,credit:"0.00",dimensions:{}},{accountId:equity,debit:"0.00",credit:amount,dimensions:{}}]});
const create=(amount="100.00")=>createJournal(maker,org,entity,body(amount),randomUUID(),randomUUID());
const submit=(id:string,version=1,key=randomUUID())=>submitJournal(maker,org,entity,id,{},version,key,randomUUID());
const approve=(id:string,version:number,actor=checker,key=randomUUID())=>approveJournal(actor,org,entity,id,{reason:"Reviewed frozen fictional adjustment"},version,key,randomUUID());
const post=(id:string,version:number,key=randomUUID(),actor=finance)=>postJournal(actor,org,entity,id,{},version,key,randomUUID());
async function approved(amount="100.00"){const draft=await create(amount);await submit(draft.id);const a=await approve(draft.id,2);if(a.status==="submitted")await approve(draft.id,3,second);return getJournal(finance,org,entity,draft.id);}
beforeAll(async()=>{
  const url=new URL(process.env.MIGRATION_DATABASE_URL??"");if(url.hostname!=="127.0.0.1"||url.pathname!=="/kaamledger")throw new Error("Journal lifecycle fixtures require the dedicated local database.");
  for(const id of users)await admin.query("INSERT INTO auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Lifecycle fixture',$2,true,now(),now())",[id,`${id}@example.invalid`]);
  await admin.query("INSERT INTO organizations(id,name) VALUES($1,'Lifecycle fixture')",[org]);
  for(const id of [entity,otherEntity])await admin.query("INSERT INTO legal_entities(id,organization_id,name,active_modes,reporting_profile,created_by) VALUES($1,$2,'Lifecycle company','[\"labour\"]','demo_accrual',$3)",[id,org,finance]);
  for(const [id,roles]of [[maker,["accountant"]],[finance,["finance_manager"]],[checker,["finance_manager","policy_reviewer"]],[second,["finance_manager"]],[reader,["auditor"]]] as const)await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,$4,$5,'[]')",[randomUUID(),org,id,JSON.stringify(roles),JSON.stringify([entity,otherEntity])]);
  for(const type of ["expense","equity"]as const){const a=await createAccount(finance,org,entity,{code:type,name:type,type,normalSide:type==="expense"?"debit":"credit",isControl:false,reportMapping:{statementSection:type==="expense"?"expenses":"equity",cashFlowCategory:"unclassified"}},randomUUID(),randomUUID());if(type==="expense")expense=a.id;else equity=a.id;}
  const year=await createFiscalYear(finance,org,entity,{fiscalYearLabel:"Reversal year",retainedEarningsAccountId:equity,periods:[{startDate:"2026-01-01",endDateExclusive:"2026-11-01"},{startDate:"2026-11-01",endDateExclusive:"2027-01-01"}]},randomUUID(),randomUUID());period=year.periods[0].id;reversalPeriod=year.periods[1].id;
  const p=await createPolicy(finance,org,entity,{name:"Independent manual review",effectiveFrom:"2026-01-01",effectiveTo:"2027-01-01",aggregateTypes:["journal"],currency:"NPR",makerChecker:true,thresholds:[{minInclusive:"0.00",maxExclusive:"100.00",requiredPermission:"journals.approve",numberOfDistinctApprovers:1},{minInclusive:"100.00",requiredPermission:"journals.approve",numberOfDistinctApprovers:2}]},randomUUID(),randomUUID());await activatePolicy(checker,org,entity,p.id,{},1,randomUUID(),randomUUID());
});
afterAll(async()=>{
  const url=new URL(process.env.MIGRATION_DATABASE_URL??"");if(url.hostname!=="127.0.0.1"||url.pathname!=="/kaamledger"){await admin.end();return;}
  const triggers=[...['manual_journal_reversals','manual_journal_reversal_requests','journal_reversal_holds'].map(t=>[t,'reversal_immutable']),['manual_journal_results','manual_result_immutable'],['manual_journal_revisions','manual_revision_immutable'],['manual_journal_drafts','manual_draft_no_delete'],...['journal_posting_results','journal_posting_events','journal_source_postings','journal_posting_decisions','journal_posting_sources'].map(t=>[t,'posting_immutable']),['journal_lines','journal_line_immutable'],['journal_entries','journal_entry_immutable'],['document_numbers','document_number_immutable'],['document_series','document_series_no_delete'],['fiscal_periods','fiscal_period_immutable'],['fiscal_years','fiscal_year_immutable'],['account_versions','account_version_append_only'],['accounts','account_no_delete'],['audit_events','audit_append_only'],['approval_policies','approval_policy_no_delete']];
  const client=await admin.connect();try{await client.query("BEGIN");for(const [table,trigger]of triggers)await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    for(const table of ['manual_journal_reversals','manual_journal_reversal_requests','journal_reversal_holds','manual_journal_execution_permits','manual_journal_results','manual_journal_revisions','manual_journal_drafts','journal_posting_results','journal_posting_events','journal_source_postings','journal_posting_decisions','journal_posting_sources','journal_lines','journal_entries','document_numbers','document_series','fiscal_periods','fiscal_years','account_versions','accounts','alerts','outbox_events','audit_events','idempotency_results','approval_policies','memberships','legal_entities'])await client.query(`DELETE FROM ${table} WHERE organization_id=$1`,[org]);
    await client.query("DELETE FROM organizations WHERE id=$1",[org]);await client.query("DELETE FROM auth_user WHERE id=ANY($1::text[])",[users]);await client.query("SET CONSTRAINTS ALL IMMEDIATE");for(const [table,trigger]of triggers)await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();await admin.end();await databasePool().end();}
});
const reverse=(id:string,version:number,key=randomUUID(),date="2026-11-10",actor=finance)=>reverseJournal(actor,org,entity,id,{postingDate:date,reason:"Correct fictional original adjustment"},version,key,randomUUID());
async function original(){const a=await approved();await post(a.id,a.version);return getJournal(finance,org,entity,a.id);}
async function reviewed(id:string){await submitJournal(finance,org,entity,id,{},1,randomUUID(),randomUUID());await approve(id,2);await approve(id,3,second);return getJournal(finance,org,entity,id);}
it("prepares exact inverse lines and requires fresh independent approval before dated posting",async()=>{
  const a=await original(),before=(await admin.query("SELECT * FROM manual_journal_drafts WHERE id=$1",[a.id])).rows[0],beforeLedger=(await admin.query("SELECT * FROM journal_entries WHERE id=$1",[a.journalId])).rows[0];
  const request=await reverse(a.id,a.version),r=await getJournal(finance,org,entity,request.resourceId);expect(request.status).toBe("draft");expect(r).toMatchObject({reversalOf:a.journalId,reversalOfSourceId:a.id,eventKind:"reverse",postingDate:"2026-11-10",review:null});
  expect(r.lines.map(l=>({accountId:l.accountId,debit:l.debit,credit:l.credit,dimensions:l.dimensions}))).toEqual(a.lines.map(l=>({accountId:l.accountId,debit:l.credit,credit:l.debit,dimensions:l.dimensions})));
  expect((await getJournal(reader,org,entity,a.id)).reversalRequestId).toBe(r.id);await expect(post(r.id,1)).rejects.toMatchObject({code:"INVALID_STATE"});
  await submitJournal(finance,org,entity,r.id,{},1,randomUUID(),randomUUID());await expect(approve(r.id,2,finance)).rejects.toMatchObject({code:"SELF_APPROVAL"});await expect(post(r.id,2)).rejects.toMatchObject({code:"APPROVAL_REQUIRED"});await approve(r.id,2);await approve(r.id,3,second);
  const key=randomUUID(),[x,y]=await Promise.all([post(r.id,4,key),post(r.id,4,key)]);expect(x).toEqual(y);expect(await post(r.id,4,randomUUID(),second)).toEqual(x);
  const result=await getJournal(reader,org,entity,a.id);expect(result).toMatchObject({status:"reversed",version:a.version,reversalJournalId:x.journalId});
  expect((await admin.query("SELECT * FROM manual_journal_drafts WHERE id=$1",[a.id])).rows[0]).toEqual(before);expect((await admin.query("SELECT * FROM journal_entries WHERE id=$1",[a.journalId])).rows[0]).toEqual(beforeLedger);
  const balance=await admin.query("SELECT account_id,sum(debit-credit)::text AS net FROM journal_lines WHERE journal_id=ANY($1::uuid[]) GROUP BY account_id ORDER BY account_id",[[a.journalId,x.journalId]]);expect(balance.rows.map(row=>row.net)).toEqual(["0.00","0.00"]);
  expect((await admin.query("SELECT count(*)::int AS n FROM journal_entries WHERE posting_date<='2026-10-31' AND id=ANY($1::uuid[])",[[a.journalId,x.journalId]])).rows[0].n).toBe(1);
  expect((await admin.query("SELECT event_kind FROM document_numbers WHERE source_id=$1",[r.id])).rows).toEqual([{event_kind:"reverse"}]);expect((await admin.query("SELECT event_kind FROM journal_entries WHERE id=$1",[x.journalId])).rows).toEqual([{event_kind:"reverse"}]);
  for(const table of ['manual_journal_reversals','journal_posting_events'])expect((await admin.query(`SELECT * FROM ${table} WHERE ${table==='manual_journal_reversals'?'reversal_journal_id':'journal_id'}=$1`,[x.journalId])).rowCount).toBe(1);
  expect((await admin.query("SELECT * FROM audit_events WHERE target_id=$1 AND action='journal.reversed'",[a.id])).rowCount).toBe(1);
});
it("competing creation keys reserve one reversal and original-key replay survives cancellation",async()=>{
  const a=await original(),key=randomUUID(),results=await Promise.allSettled([reverse(a.id,a.version,key),reverse(a.id,a.version)]);expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);
  const response=results[0].status==="fulfilled"?results[0].value:(results[1] as PromiseFulfilledResult<Awaited<ReturnType<typeof reverse>>>).value;
  if(results[0].status==="fulfilled"){expect(await reverse(a.id,a.version,key)).toEqual(response);await expect(reverseJournal(finance,org,entity,a.id,{postingDate:"2026-12-10",reason:"Different binding"},a.version,key,randomUUID())).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});}
  await cancelJournal(finance,org,entity,response.resourceId,{reason:"Change intended reversal date"},1,randomUUID(),randomUUID());const replacement=await reverse(a.id,a.version,randomUUID(),"2026-12-10");expect(replacement.resourceId).not.toBe(response.resourceId);expect((await admin.query("SELECT * FROM manual_journal_reversal_requests WHERE original_draft_id=$1",[a.id])).rowCount).toBe(2);
});
it("reversal lines and dates cannot be repurposed through PATCH or direct runtime SQL",async()=>{
  const a=await original(),r=await reverse(a.id,a.version),current=await getJournal(finance,org,entity,r.resourceId);
  await expect(patchJournal(finance,org,entity,r.resourceId,{lines:body("99.99").lines},1,randomUUID())).rejects.toMatchObject({code:"REVERSAL_CONTENT_LOCKED"});
  await expect(patchJournal(finance,org,entity,r.resourceId,{postingDate:"2026-12-10"},1,randomUUID())).rejects.toMatchObject({code:"REVERSAL_CONTENT_LOCKED"});
  expect((await patchJournal(finance,org,entity,r.resourceId,{description:"Clear reviewed reversal explanation"},1,randomUUID())).version).toBe(2);
  expect((await getJournal(reader,org,entity,r.resourceId)).lines).toEqual(current.lines);
  await expect(withScope(finance,org,entity,"journals.reverse",c=>c.query("UPDATE manual_journal_reversal_requests SET posting_date='2026-12-10' WHERE draft_id=$1",[r.resourceId]))).rejects.toThrow(/permission denied/);
});
it("private dependency holds block creation and are rechecked after approval before posting",async()=>{
  const a=await original(),b=await original(),r=await reverse(b.id,b.version);await reviewed(r.resourceId);
  for(const journal of [a.journalId,b.journalId])await admin.query("INSERT INTO journal_reversal_holds VALUES($1,$2,$3,'reconciliation',$4,'Synthetic dependent reconciliation')",[org,entity,journal,randomUUID()]);
  await expect(reverse(a.id,a.version)).rejects.toMatchObject({code:"REVERSAL_DEPENDENCY"});await expect(post(r.resourceId,4)).rejects.toMatchObject({code:"REVERSAL_DEPENDENCY"});
  expect((await getJournal(finance,org,entity,r.resourceId)).status).toBe("approved");expect((await admin.query("SELECT * FROM journal_entries WHERE source_id=$1",[r.resourceId])).rowCount).toBe(0);
  await expect(withScope(finance,org,entity,"journals.reverse",c=>c.query("DELETE FROM journal_reversal_holds"))).rejects.toThrow(/permission denied/);
});
it("a closed original period can retain history while an open later period receives the inverse",async()=>{
  const a=await original();await admin.query("ALTER TABLE fiscal_periods DISABLE TRIGGER fiscal_period_immutable");try{await admin.query("UPDATE fiscal_periods SET state='hard_closed' WHERE id=$1",[period]);await expect(reverse(a.id,a.version,randomUUID(),"2026-10-11")).rejects.toMatchObject({code:"PERIOD_CLOSED"});const later=await reverse(a.id,a.version);await reviewed(later.resourceId);expect((await post(later.resourceId,4)).status).toBe("posted");}finally{await admin.query("UPDATE fiscal_periods SET state='open' WHERE id=$1",[period]);await admin.query("ALTER TABLE fiscal_periods ENABLE TRIGGER fiscal_period_immutable");}
  const b=await original();await expect(reverse(b.id,b.version,randomUUID(),"2026-10-09")).rejects.toMatchObject({code:"REVERSAL_DATE"});
  const r=await reverse(b.id,b.version);await reviewed(r.resourceId);await admin.query("ALTER TABLE fiscal_periods DISABLE TRIGGER fiscal_period_immutable");try{await admin.query("UPDATE fiscal_periods SET state='soft_closed' WHERE id=$1",[reversalPeriod]);await expect(post(r.resourceId,4)).rejects.toMatchObject({code:"PERIOD_CLOSED"});}finally{await admin.query("UPDATE fiscal_periods SET state='open' WHERE id=$1",[reversalPeriod]);await admin.query("ALTER TABLE fiscal_periods ENABLE TRIGGER fiscal_period_immutable");}
});
it("reversal-link insertion failure rolls back number, journal, source, audit, event and permits",async()=>{
  const a=await original(),r=await reverse(a.id,a.version);await reviewed(r.resourceId);const name=`reversal_fault_${randomUUID().replaceAll('-','')}`,key=randomUUID();await admin.query(`ALTER TABLE manual_journal_reversals ADD CONSTRAINT ${name} CHECK(original_journal_id<>'${a.journalId}'::uuid) NOT VALID`);
  try{await expect(post(r.resourceId,4,key)).rejects.toMatchObject({code:"23514"});for(const table of ['journal_entries','document_numbers','journal_posting_events','journal_source_postings'])expect((await admin.query(`SELECT * FROM ${table} WHERE source_id=$1`,[r.resourceId])).rowCount).toBe(0);expect((await getJournal(finance,org,entity,a.id)).status).toBe("posted");expect((await admin.query("SELECT * FROM manual_journal_execution_permits WHERE draft_id=$1",[r.resourceId])).rowCount).toBe(0);}finally{await admin.query(`ALTER TABLE manual_journal_reversals DROP CONSTRAINT ${name}`);}
  expect((await post(r.resourceId,4,key)).status).toBe("posted");
});
it("cross-entity, read-only, unscoped and revoked callers cannot create or replay reversals",async()=>{
  const a=await original(),key=randomUUID();await expect(reverse(a.id,a.version,key,"2026-11-10",reader)).rejects.toMatchObject({status:403});
  await expect(reverseJournal(finance,org,otherEntity,a.id,{postingDate:"2026-11-10",reason:"Wrong scope"},a.version,key,randomUUID())).rejects.toMatchObject({status:404});await reverse(a.id,a.version,key);
  await admin.query("UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2",[org,finance]);try{await expect(reverse(a.id,a.version,key)).rejects.toMatchObject({status:404});}finally{await admin.query("UPDATE memberships SET active=true WHERE organization_id=$1 AND user_id=$2",[org,finance]);}
  await expect(databasePool().query("SELECT app_security.request_manual_journal_reversal($1,$2,$3,$4,'2026-11-10','Unscoped attempt',$5,$6)",[org,entity,a.id,a.version,randomUUID(),randomUUID()])).rejects.toThrow("FORBIDDEN");
});
it("completed links are immutable, cannot be reversed twice, and cannot reverse a reversal",async()=>{
  const a=await original(),r=await reverse(a.id,a.version);await reviewed(r.resourceId);const ledger=await post(r.resourceId,4);await expect(reverse(a.id,a.version)).rejects.toMatchObject({code:"ALREADY_REVERSED"});await expect(reverse(r.resourceId,5)).rejects.toMatchObject({code:"REVERSAL_SOURCE_UNSUPPORTED"});
  for(const table of ['manual_journal_reversals','manual_journal_reversal_requests'])await expect(admin.query(`UPDATE ${table} SET created_at=clock_timestamp() WHERE organization_id=$1`,[org])).rejects.toThrow(/append-only/);
  expect((await admin.query("SELECT * FROM journal_entries WHERE id=$1",[ledger.journalId])).rows[0].status).toBe("posted");
});
it("account changes invalidate fresh reversal approval without rewriting original master snapshots",async()=>{
  const a=await original(),r=await reverse(a.id,a.version);await reviewed(r.resourceId);await patchAccount(finance,org,entity,expense,{name:"Current renamed expense"},1,randomUUID());await expect(post(r.resourceId,4)).rejects.toMatchObject({code:"APPROVAL_INVALIDATED"});
  const updated=await patchJournal(finance,org,entity,r.resourceId,{description:"Revalidated reverse master"},4,randomUUID());expect(updated.lines[0].accountVersion).toBe(2);expect((await getJournal(reader,org,entity,a.id)).lines[0].accountVersion).toBe(1);
});
