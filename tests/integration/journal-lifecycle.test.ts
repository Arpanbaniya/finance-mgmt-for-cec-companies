import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, expect, it } from "vitest";
import { databasePool } from "@/db/client";
import { withScope } from "@/features/identity/scope";
import { createAccount, patchAccount } from "@/features/accounting/accounts-service";
import { createFiscalYear } from "@/features/accounting/setup-service";
import { createPolicy, activatePolicy } from "@/features/approvals/service";
import { approveJournalSource, postAuthorizedJournal } from "@/features/accounting/authorized-posting";
import { createJournal, patchJournal, cancelJournal, getJournal, submitJournal, approveJournal, rejectJournal, postJournal } from "@/features/accounting/journal-service";
import { readGeneralLedger } from "@/features/reporting/general-ledger-service";
config({ path: ".env.local", quiet: true });
const org=randomUUID(),entity=randomUUID(),otherEntity=randomUUID(),maker=`lifecycle-${randomUUID()}`,finance=`lifecycle-${randomUUID()}`,checker=`lifecycle-${randomUUID()}`,second=`lifecycle-${randomUUID()}`,reader=`lifecycle-${randomUUID()}`;
const users=[maker,finance,checker,second,reader],admin=new Pool({connectionString:process.env.MIGRATION_DATABASE_URL});
let expense="",equity="",period="";
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
  const year=await createFiscalYear(finance,org,entity,{fiscalYearLabel:"Lifecycle year",retainedEarningsAccountId:equity,periods:[{startDate:"2026-01-01",endDateExclusive:"2027-01-01"}]},randomUUID(),randomUUID());period=year.periods[0].id;
  const p=await createPolicy(finance,org,entity,{name:"Independent manual review",effectiveFrom:"2026-01-01",effectiveTo:"2027-01-01",aggregateTypes:["journal"],currency:"NPR",makerChecker:true,thresholds:[{minInclusive:"0.00",maxExclusive:"100.00",requiredPermission:"journals.approve",numberOfDistinctApprovers:1},{minInclusive:"100.00",requiredPermission:"journals.approve",numberOfDistinctApprovers:2}]},randomUUID(),randomUUID());await activatePolicy(checker,org,entity,p.id,{},1,randomUUID(),randomUUID());
});
afterAll(async()=>{
  const url=new URL(process.env.MIGRATION_DATABASE_URL??"");if(url.hostname!=="127.0.0.1"||url.pathname!=="/kaamledger"){await admin.end();return;}
  const triggers=[['manual_journal_results','manual_result_immutable'],['manual_journal_revisions','manual_revision_immutable'],['manual_journal_drafts','manual_draft_no_delete'],...['journal_posting_results','journal_posting_events','journal_source_postings','journal_posting_decisions','journal_posting_sources'].map(t=>[t,'posting_immutable']),['journal_lines','journal_line_immutable'],['journal_entries','journal_entry_immutable'],['document_numbers','document_number_immutable'],['document_series','document_series_no_delete'],['fiscal_periods','fiscal_period_immutable'],['fiscal_years','fiscal_year_immutable'],['account_versions','account_version_append_only'],['accounts','account_no_delete'],['audit_events','audit_append_only'],['approval_policies','approval_policy_no_delete']];
  const client=await admin.connect();try{await client.query("BEGIN");for(const [table,trigger]of triggers)await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    for(const table of ['manual_journal_execution_permits','manual_journal_results','manual_journal_revisions','manual_journal_drafts','journal_posting_results','journal_posting_events','journal_source_postings','journal_posting_decisions','journal_posting_sources','journal_lines','journal_entries','document_numbers','document_series','fiscal_periods','fiscal_years','account_versions','accounts','alerts','outbox_events','audit_events','idempotency_results','approval_policies','memberships','legal_entities'])await client.query(`DELETE FROM ${table} WHERE organization_id=$1`,[org]);
    await client.query("DELETE FROM organizations WHERE id=$1",[org]);await client.query("DELETE FROM auth_user WHERE id=ANY($1::text[])",[users]);await client.query("SET CONSTRAINTS ALL IMMEDIATE");for(const [table,trigger]of triggers)await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();await admin.end();await databasePool().end();}
});
it("submits saved content with a frozen policy without granting raw source preparation",async()=>{
  const a=await create();const result=await submit(a.id);expect(result).toMatchObject({status:"submitted",version:2});
  const current=await getJournal(reader,org,entity,a.id);expect(current.review).toMatchObject({sourceVersion:1,requiredApprovals:2,validApprovals:0,snapshotValid:true,canApprove:false});
  const source=(await admin.query("SELECT * FROM journal_posting_sources WHERE source_id=$1",[a.id])).rows[0];expect(source.body).toEqual({postingDate:a.postingDate,documentDate:a.documentDate,description:a.description,currency:"NPR",lines:a.lines});
  await expect(submitJournal(finance,org,entity,a.id,{},2,randomUUID(),randomUUID())).rejects.toMatchObject({code:"MAKER_REQUIRED"});
  await expect(withScope(maker,org,entity,"journals.submit",c=>c.query("SELECT app_security.prepare_journal_posting_source($1,$2,$3,2,'{}','{}',$4)",[org,entity,a.id,randomUUID()]))).rejects.toThrow(/permission denied/);
});
it("requires two distinct reviewers at the exact threshold, but only one below it",async()=>{
  const a=await create();await submit(a.id);await expect(post(a.id,2)).rejects.toMatchObject({code:"APPROVAL_REQUIRED"});expect((await approve(a.id,2)).status).toBe("submitted");await expect(approve(a.id,3)).rejects.toMatchObject({code:"ALREADY_APPROVED"});expect((await approve(a.id,3,second)).status).toBe("approved");expect((await getJournal(finance,org,entity,a.id)).review?.validApprovals).toBe(2);
  const small=await create("99.99");await submit(small.id);expect((await approve(small.id,2)).status).toBe("approved");
});
it("creator and any prior content editor cannot approve, including through raw commands",async()=>{
  const a=await create();await patchJournal(finance,org,entity,a.id,{description:"Finance contributed content"},1,randomUUID());await submit(a.id,2);
  await expect(approve(a.id,3,finance)).rejects.toMatchObject({code:"SELF_APPROVAL"});
  await admin.query("UPDATE memberships SET roles='[\"accountant\",\"finance_manager\"]' WHERE organization_id=$1 AND user_id=$2",[org,maker]);try{await expect(approve(a.id,3,maker)).rejects.toMatchObject({code:"SELF_APPROVAL"});}finally{await admin.query("UPDATE memberships SET roles='[\"accountant\"]' WHERE organization_id=$1 AND user_id=$2",[org,maker]);}
  await expect(approveJournalSource(checker,org,entity,a.id,1,"Raw bypass attempt",randomUUID())).rejects.toMatchObject({code:"FORBIDDEN"});
  await expect(postAuthorizedJournal(finance,org,entity,a.id,1,randomUUID(),randomUUID())).rejects.toMatchObject({code:"FORBIDDEN"});
  for(const sql of ["SELECT * FROM manual_journal_execution_permits","INSERT INTO manual_journal_execution_permits DEFAULT VALUES"])await expect(withScope(finance,org,entity,"journals.approve",c=>c.query(sql))).rejects.toThrow(/permission denied/);
});
it("edits invalidate frozen decisions and resubmission requires fresh independent approval",async()=>{
  const a=await approved();const changed=await patchJournal(maker,org,entity,a.id,{description:"Corrected adjustment"},a.version,randomUUID());expect(changed.status).toBe("draft");expect((await getJournal(maker,org,entity,a.id)).review).toBeNull();
  await expect(post(a.id,changed.version)).rejects.toMatchObject({code:"INVALID_STATE"});await submit(a.id,changed.version);const current=await getJournal(checker,org,entity,a.id);expect(current.review).toMatchObject({sourceVersion:2,validApprovals:0});
  expect((await admin.query("SELECT * FROM journal_posting_decisions WHERE command_id IN (SELECT id FROM journal_posting_sources WHERE source_id=$1 AND source_version=1)",[a.id])).rowCount).toBe(2);
});
it("rejection and cancellation retain frozen history but prevent consumption",async()=>{
  const a=await approved();const key=randomUUID(),r=await rejectJournal(checker,org,entity,a.id,{reason:"Correct the evidence explanation"},a.version,key,randomUUID());expect(r.status).toBe("draft");expect(await rejectJournal(checker,org,entity,a.id,{reason:"Correct the evidence explanation"},a.version,key,randomUUID())).toEqual(r);
  await submit(a.id,r.version);const current=await getJournal(maker,org,entity,a.id);await cancelJournal(maker,org,entity,a.id,{reason:"Withdraw fictional adjustment"},current.version,randomUUID(),randomUUID());
  expect((await getJournal(maker,org,entity,a.id)).status).toBe("cancelled");await expect(post(a.id,current.version+1)).rejects.toMatchObject({code:"INVALID_STATE"});expect((await admin.query("SELECT * FROM journal_posting_sources WHERE source_id=$1",[a.id])).rowCount).toBe(2);
});
it("racing post commands commit one ledger, source transition, number, outbox and original response",async()=>{
  const a=await approved(),key=randomUUID();const [x,y]=await Promise.all([post(a.id,a.version,key),post(a.id,a.version,key)]);expect(x).toEqual(y);expect(x.status).toBe("posted");expect(await post(a.id,a.version,randomUUID(),second)).toEqual(x);
  const current=await getJournal(reader,org,entity,a.id);expect(current.journalId).toBe(x.journalId);expect(current.number).toMatch(/journal/i);expect(current.review?.snapshotValid).toBe(true);
  const ledger=await readGeneralLedger(reader,org,entity,{accountId:expense,fromDate:"2026-01-01",toDateExclusive:"2027-01-01"});
  const sourceLine=ledger.rows.find(line=>line.journalId===x.journalId)!;expect(sourceLine.manualJournalId).toBe(a.id);
  expect((await getJournal(reader,org,entity,sourceLine.manualJournalId!)).review?.validApprovals).toBe(2);
  for(const table of ['journal_entries','document_numbers','journal_posting_events','journal_source_postings'])expect((await admin.query(`SELECT * FROM ${table} WHERE source_id=$1`,[a.id])).rowCount).toBe(1);
  expect((await admin.query("SELECT * FROM audit_events WHERE target_id=$1 AND action='journal.post'",[a.id])).rowCount).toBe(1);expect((await admin.query("SELECT * FROM manual_journal_execution_permits WHERE draft_id=$1",[a.id])).rowCount).toBe(0);
  await expect(patchJournal(maker,org,entity,a.id,{description:"Rewrite posted source"},current.version,randomUUID())).rejects.toMatchObject({code:"INVALID_STATE"});await expect(cancelJournal(maker,org,entity,a.id,{reason:"Erase posted source"},current.version,randomUUID(),randomUUID())).rejects.toMatchObject({code:"INVALID_STATE"});await expect(admin.query("UPDATE manual_journal_drafts SET body='{}' WHERE id=$1",[a.id])).rejects.toThrow(/immutable/);
});
it("replay precedes stale rejection and binds the original version and reason",async()=>{
  const a=await create(),key=randomUUID(),r=await submit(a.id,1,key);await approve(a.id,2);expect(await submit(a.id,1,key)).toEqual(r);await expect(submit(a.id,2,key)).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
  await expect(approve(a.id,2,second)).rejects.toMatchObject({code:"STALE_VERSION"});
});
it("revoked reviewer does not satisfy quorum and a revoked poster cannot replay",async()=>{
  const a=await approved();await admin.query("UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2",[org,second]);try{expect((await getJournal(finance,org,entity,a.id)).review?.validApprovals).toBe(1);await expect(post(a.id,a.version)).rejects.toMatchObject({code:"APPROVAL_REQUIRED"});}finally{await admin.query("UPDATE memberships SET active=true WHERE organization_id=$1 AND user_id=$2",[org,second]);}
  const key=randomUUID();await post(a.id,a.version,key);await admin.query("UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2",[org,finance]);try{await expect(post(a.id,a.version,key)).rejects.toMatchObject({status:404});}finally{await admin.query("UPDATE memberships SET active=true WHERE organization_id=$1 AND user_id=$2",[org,finance]);}
});
it("head-revision failure rolls back journal, number, source, event and permit atomically",async()=>{
  const a=await approved(),constraint=`lifecycle_fault_${randomUUID().replaceAll('-','')}`;await admin.query(`ALTER TABLE manual_journal_revisions ADD CONSTRAINT ${constraint} CHECK(draft_id<>'${a.id}'::uuid OR version<>${a.version+1}) NOT VALID`);const key=randomUUID();
  try{await expect(post(a.id,a.version,key)).rejects.toMatchObject({code:"23514"});expect((await getJournal(maker,org,entity,a.id)).status).toBe("approved");for(const table of ['journal_entries','document_numbers','journal_posting_events','journal_source_postings'])expect((await admin.query(`SELECT * FROM ${table} WHERE source_id=$1`,[a.id])).rowCount).toBe(0);}finally{await admin.query(`ALTER TABLE manual_journal_revisions DROP CONSTRAINT ${constraint}`);}
  expect((await post(a.id,a.version,key)).status).toBe("posted");
});
it("closed periods reject new money but retain original committed replay",async()=>{
  const a=await approved(),b=await approved(),key=randomUUID(),r=await post(a.id,a.version,key);await admin.query("ALTER TABLE fiscal_periods DISABLE TRIGGER fiscal_period_immutable");try{await admin.query("UPDATE fiscal_periods SET state='hard_closed' WHERE id=$1",[period]);expect(await post(a.id,a.version,key)).toEqual(r);await expect(post(b.id,b.version)).rejects.toMatchObject({code:"PERIOD_CLOSED"});}finally{await admin.query("UPDATE fiscal_periods SET state='open' WHERE id=$1",[period]);await admin.query("ALTER TABLE fiscal_periods ENABLE TRIGGER fiscal_period_immutable");}
});
it("guessed entity, reader and missing SQL scope cannot transition a draft",async()=>{
  const a=await create();await expect(submitJournal(maker,org,otherEntity,a.id,{},1,randomUUID(),randomUUID())).rejects.toMatchObject({status:404});await expect(approve(a.id,1,reader)).rejects.toMatchObject({status:403});
  await expect(databasePool().query("SELECT app_security.transition_manual_journal($1,$2,$3,1,'post',NULL,$4,NULL,$5)",[org,entity,a.id,randomUUID(),randomUUID()])).rejects.toThrow("FORBIDDEN");
});
it("account changes invalidate a submission and fresh draft save re-resolves versions",async()=>{
  const a=await approved();const changed=await patchAccount(finance,org,entity,expense,{name:"Changed expense master"},1,randomUUID());expect(changed.version).toBe(2);expect((await getJournal(checker,org,entity,a.id)).review?.snapshotValid).toBe(false);await expect(post(a.id,a.version)).rejects.toMatchObject({code:"APPROVAL_INVALIDATED"});
  const draft=await patchJournal(maker,org,entity,a.id,{description:"Revalidated account master"},a.version,randomUUID());await submit(a.id,draft.version);expect((await getJournal(checker,org,entity,a.id)).lines[0].accountVersion).toBe(2);
});
