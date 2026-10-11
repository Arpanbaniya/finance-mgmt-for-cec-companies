import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { beforeAll, afterAll, expect, it } from "vitest";
import { databasePool } from "@/db/client";
import { withScope } from "@/features/identity/scope";
import { createAccount, patchAccount } from "@/features/accounting/accounts-service";
import { createFiscalYear, patchAccountMappings } from "@/features/accounting/setup-service";
import { purposeRules, type AccountPurpose } from "@/domain/finance-setup";
import { statementSections, type AccountType, type ControlType } from "@/domain/accounts";
import type { z } from "zod";
import { createPolicy, activatePolicy } from "@/features/approvals/service";
import { ApprovalPolicyCreate } from "@/domain/approval-policy";
import { canonicalJSON, contentHash, type JsonValue } from "@/domain/approvals";
import { prepareManualPosting } from "@/domain/posting";
import { prepareJournalSource, approveJournalSource, postAuthorizedJournal, postAuthorizedJournalInTransaction } from "@/features/accounting/authorized-posting";

config({ path: ".env.local", quiet: true });
const org=randomUUID(), entity=randomUUID(), foreignEntity=randomUUID();
const maker=`source-${randomUUID()}`, poster=`source-${randomUUID()}`, checker=`source-${randomUUID()}`, second=`source-${randomUUID()}`, reader=`source-${randomUUID()}`;
const users=[maker,poster,checker,second,reader], admin=new Pool({connectionString:process.env.MIGRATION_DATABASE_URL});
let expense="", equity="", branch="", period="", policy="";
const body=(amount="100.00")=>({postingDate:"2026-10-05",documentDate:"2026-10-04",description:"Fictional approved manual adjustment",currency:"NPR",lines:[
  {accountId:expense,accountVersion:1,debit:amount,credit:"0.00",dimensions:{branchId:branch}},
  {accountId:equity,accountVersion:1,debit:"0.00",credit:amount,dimensions:{}},
]});
async function producer<T>(run:(client:PoolClient)=>Promise<T>){const client=await admin.connect();try{
  await client.query("BEGIN");await client.query("SELECT set_config('app.user_id',$1,true),set_config('app.org_id',$2,true),set_config('app.entity_id',$3,true)",[maker,org,entity]);
  const result=await run(client);await client.query("COMMIT");return result;
}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}}
const prepare=(source=randomUUID(),revision=1,input:unknown=body())=>producer(client=>prepareJournalSource(client,org,entity,source,revision,input,randomUUID()));
const approve=(source:string,actor=checker,revision=1,reason="Independent review of frozen source")=>approveJournalSource(actor,org,entity,source,revision,reason,randomUUID());
const post=(source:string,key=randomUUID(),actor=poster,revision=1)=>postAuthorizedJournal(actor,org,entity,source,revision,key,randomUUID());
async function approved(input:unknown=body()){const source=randomUUID();await prepare(source,1,input);await approve(source);await approve(source,second);return source;}

beforeAll(async()=>{
  const url=new URL(process.env.MIGRATION_DATABASE_URL??"");if(url.hostname!=="127.0.0.1"||url.pathname!=="/kaamledger")throw new Error("Authorized posting fixtures require the dedicated local database.");
  for(const id of users)await admin.query("INSERT INTO auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Source fixture',$2,true,now(),now())",[id,`${id}@example.invalid`]);
  await admin.query("INSERT INTO organizations(id,name) VALUES($1,'Authorized posting fixture')",[org]);
  for(const id of [entity,foreignEntity])await admin.query("INSERT INTO legal_entities(id,organization_id,name,active_modes,reporting_profile,created_by) VALUES($1,$2,'Source company','[\"labour\"]','demo_accrual',$3)",[id,org,poster]);
  for(const [id,roles] of [[maker,["accountant"]],[poster,["finance_manager"]],[checker,["finance_manager","policy_reviewer"]],[second,["finance_manager"]],[reader,["auditor"]]] as const)await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,$4,$5,'[]')",[randomUUID(),org,id,JSON.stringify(roles),JSON.stringify([entity])]);
  for(const type of ["expense","equity"] as const){const account=await createAccount(poster,org,entity,{code:type.toUpperCase(),name:type,type,normalSide:type==="expense"?"debit":"credit",isControl:false,controlType:null,reportMapping:{statementSection:type==="expense"?"expenses":"equity",cashFlowCategory:"unclassified"}},randomUUID(),randomUUID());if(type==="expense")expense=account.id;else equity=account.id;}
  const year=await createFiscalYear(poster,org,entity,{fiscalYearLabel:"Source calendar",retainedEarningsAccountId:equity,periods:[{startDate:"2026-01-01",endDateExclusive:"2027-01-01"}]},randomUUID(),randomUUID());period=year.periods[0].id;
  branch=randomUUID();await admin.query("INSERT INTO branches(id,organization_id,legal_entity_id,name) VALUES($1,$2,$3,'Prepared branch')",[branch,org,entity]);
  const definition=ApprovalPolicyCreate.parse({name:"Independent manual review",effectiveFrom:"2026-01-01",effectiveTo:"2027-01-01",aggregateTypes:["journal"],currency:"NPR",makerChecker:true,thresholds:[{minInclusive:"0.00",maxExclusive:"100.00",requiredPermission:"journals.approve",numberOfDistinctApprovers:1},{minInclusive:"100.00",requiredPermission:"journals.approve",numberOfDistinctApprovers:2}]});
  const created=await createPolicy(poster,org,entity,definition,randomUUID(),randomUUID());policy=created.id;await activatePolicy(checker,org,entity,policy,{},1,randomUUID(),randomUUID());
});
afterAll(async()=>{
  const url=new URL(process.env.MIGRATION_DATABASE_URL??"");if(url.hostname!=="127.0.0.1"||url.pathname!=="/kaamledger"){await admin.end();return;}
  const client=await admin.connect();const triggers=[...['journal_posting_results','journal_posting_events','journal_source_postings','journal_posting_decisions','journal_posting_sources'].map(table=>[table,'posting_immutable']),['journal_lines','journal_line_immutable'],['journal_entries','journal_entry_immutable'],['document_numbers','document_number_immutable'],['document_series','document_series_no_delete'],['account_mapping_entries','mapping_entry_immutable'],['account_mapping_revisions','mapping_revision_immutable'],['fiscal_periods','fiscal_period_immutable'],['fiscal_years','fiscal_year_immutable'],['account_versions','account_version_append_only'],['accounts','account_no_delete'],['audit_events','audit_append_only'],['approval_policies','approval_policy_no_delete']];
  try{await client.query("BEGIN");for(const [table,trigger]of triggers)await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    for(const table of ['journal_posting_results','journal_posting_events','journal_source_postings','journal_posting_decisions','journal_posting_sources','journal_lines','journal_entries','document_numbers','document_series','account_mapping_entries','account_mapping_revisions','fiscal_periods','fiscal_years','account_versions','accounts','branches','alerts','outbox_events','audit_events','idempotency_results','approval_policies','memberships','legal_entities'])await client.query(`DELETE FROM ${table} WHERE organization_id=$1`,[org]);
    await client.query("DELETE FROM organizations WHERE id=$1",[org]);await client.query("DELETE FROM auth_user WHERE id=ANY($1::text[])",[users]);await client.query("SET CONSTRAINTS ALL IMMEDIATE");for(const [table,trigger]of triggers)await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();await admin.end();await databasePool().end();}
});

it("freezes canonical source, applicable policy, exact amount, branch and protected version",async()=>{
  const source=randomUUID(),command=await prepare(source);const row=(await admin.query("SELECT * FROM journal_posting_sources WHERE id=$1",[command])).rows[0];
  const parsed=prepareManualPosting(body()).posting;
  expect(row).toMatchObject({source_id:source,source_version:1,maker_id:maker,amount:"100.00",policy_id:policy,policy_version:2,entity_version:1,canonical_body:canonicalJSON(parsed as JsonValue),content_hash:contentHash(parsed as JsonValue)});
  expect(row.threshold.numberOfDistinctApprovers).toBe(2);expect(row.branch_snapshots[0].id).toBe(branch);
  expect(await prepare(source)).toBe(command);await expect(prepare(source,1,{...body(),description:"Changed protected content"})).rejects.toMatchObject({code:"SOURCE_CONFLICT"});
});
it("runtime cannot fabricate source, decisions, posting receipts, outbox or result rows",async()=>{
  await expect(withScope(maker,org,entity,"journals.submit",client=>prepareJournalSource(client,org,entity,randomUUID(),1,body(),randomUUID()))).rejects.toThrow(/permission denied/);
  for(const table of ['journal_posting_sources','journal_posting_decisions','journal_source_postings','journal_posting_events','journal_posting_results']){
    for(const verb of [`INSERT INTO ${table} DEFAULT VALUES`,`DELETE FROM ${table}`,`TRUNCATE ${table}`])await expect(withScope(poster,org,entity,"journals.post",client=>client.query(verb))).rejects.toThrow(/permission denied/);
  }
});
it("creator cannot approve even with finance permission; auditor cannot decide or post",async()=>{
  const source=randomUUID();await prepare(source);
  await admin.query("UPDATE memberships SET roles='[\"accountant\",\"finance_manager\"]' WHERE organization_id=$1 AND user_id=$2",[org,maker]);
  try{await expect(approve(source,maker)).rejects.toMatchObject({code:"SELF_APPROVAL",status:403});}finally{await admin.query("UPDATE memberships SET roles='[\"accountant\"]' WHERE organization_id=$1 AND user_id=$2",[org,maker]);}
  await expect(approve(source,reader)).rejects.toMatchObject({status:403});await expect(post(source,randomUUID(),reader)).rejects.toMatchObject({status:403});
  expect((await admin.query("SELECT id FROM journal_posting_decisions WHERE command_id=(SELECT id FROM journal_posting_sources WHERE source_id=$1)",[source])).rowCount).toBe(0);
});
it("exact threshold boundary requires two distinct currently authorized reviewers",async()=>{
  const source=randomUUID();await prepare(source);await expect(post(source)).rejects.toMatchObject({code:"APPROVAL_REQUIRED"});
  const a=await approve(source);expect(await approve(source)).toBe(a);await expect(approve(source,checker,1,"Changed reason")).rejects.toMatchObject({code:"DECISION_CONFLICT"});
  await expect(post(source)).rejects.toMatchObject({code:"APPROVAL_REQUIRED"});await approve(source,second);
  expect(await post(source)).toMatchObject({resourceId:source,status:"posted",sourceVersion:1,debit:"100.00",credit:"100.00"});
  const small=randomUUID();await prepare(small,1,body("99.99"));await approve(small);expect((await post(small)).debit).toBe("99.99");
});
it("racing decisions and posts commit one source receipt, ledger, number, event and response",async()=>{
  const source=randomUUID();await prepare(source);const decisions=await Promise.all([approve(source),approve(source)]);expect(decisions[0]).toBe(decisions[1]);await approve(source,second);
  const key=randomUUID();const [a,b]=await Promise.all([post(source,key),post(source,key)]);expect(a).toEqual(b);
  expect(await post(source,randomUUID(),second)).toEqual(a);
  for(const table of ['journal_source_postings','journal_entries','document_numbers','journal_posting_events'])expect((await admin.query(`SELECT * FROM ${table} WHERE source_id=$1`,[source])).rowCount).toBe(1);
  expect((await admin.query("SELECT * FROM journal_lines WHERE journal_id=$1",[a.journalId])).rowCount).toBe(2);
  expect((await admin.query("SELECT * FROM audit_events WHERE target_id=$1 AND action='journal.source_posted'",[source])).rowCount).toBe(1);
  expect((await admin.query("SELECT * FROM journal_posting_results WHERE source_id=$1",[source])).rowCount).toBe(2);
});
it("lost-response replay preserves request ID and rejects changed key/version/source",async()=>{
  const source=await approved(),key=randomUUID(),request=randomUUID();const original=await postAuthorizedJournal(poster,org,entity,source,1,key,request);
  expect(await post(source,key)).toEqual(original);expect(original.requestId).toBe(request);
  await expect(post(source,key,poster,2)).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});await expect(post(randomUUID(),key)).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
  await expect(prepare(source,2)).rejects.toMatchObject({code:"SOURCE_ALREADY_POSTED"});
});
it("new protected version voids prior approvals without overwriting history",async()=>{
  const source=await approved();const before=(await admin.query("SELECT id FROM journal_posting_sources WHERE source_id=$1",[source])).rows[0].id;
  await prepare(source,2,{...body(),description:"Edited source revision"});
  await expect(post(source)).rejects.toMatchObject({code:"APPROVAL_INVALIDATED"});await expect(approve(source)).rejects.toMatchObject({code:"APPROVAL_INVALIDATED"});
  await expect(post(source,randomUUID(),poster,2)).rejects.toMatchObject({code:"APPROVAL_REQUIRED"});
  expect((await admin.query("SELECT * FROM journal_posting_decisions WHERE command_id=$1",[before])).rowCount).toBe(2);
  await approve(source,checker,2);await approve(source,second,2);expect((await post(source,randomUUID(),poster,2)).sourceVersion).toBe(2);
});
it("revoked approvers block new money, and current poster authority precedes replay",async()=>{
  const source=await approved();await admin.query("UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2",[org,second]);
  try{await expect(post(source)).rejects.toMatchObject({code:"APPROVAL_REQUIRED"});}finally{await admin.query("UPDATE memberships SET active=true WHERE organization_id=$1 AND user_id=$2",[org,second]);}
  const key=randomUUID(),receipt=await post(source,key);await admin.query("UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2",[org,poster]);
  try{await expect(post(source,key)).rejects.toMatchObject({status:404});}finally{await admin.query("UPDATE memberships SET active=true WHERE organization_id=$1 AND user_id=$2",[org,poster]);}
  expect(await post(source,key)).toEqual(receipt);
});
it("branch changes invalidate unposted decisions; unchanged journal history remains intact",async()=>{
  const source=await approved();await admin.query("UPDATE branches SET name='Changed branch dependency' WHERE id=$1",[branch]);
  try{await expect(post(source)).rejects.toMatchObject({code:"APPROVAL_INVALIDATED"});await expect(approve(source,poster)).rejects.toMatchObject({code:"APPROVAL_INVALIDATED"});}finally{await admin.query("UPDATE branches SET name='Prepared branch' WHERE id=$1",[branch]);}
});
it("failed dependent source effect rolls back all financial state and remains safely retryable",async()=>{
  const source=await approved(),key=randomUUID();const before=(await admin.query("SELECT next_number FROM document_series WHERE legal_entity_id=$1 AND document_type='journal'",[entity])).rows[0].next_number;
  await expect(withScope(poster,org,entity,"journals.post",async client=>{await postAuthorizedJournalInTransaction(client,org,entity,source,1,key,randomUUID());throw new Error("Injected source-effect failure");})).rejects.toThrow(/Injected/);
  for(const table of ['journal_entries','document_numbers','journal_source_postings','journal_posting_events','journal_posting_results'])expect((await admin.query(`SELECT * FROM ${table} WHERE source_id=$1`,[source])).rowCount).toBe(0);
  expect((await admin.query("SELECT * FROM audit_events WHERE target_id=$1 AND action='journal.source_posted'",[source])).rowCount).toBe(0);
  expect((await admin.query("SELECT next_number FROM document_series WHERE legal_entity_id=$1 AND document_type='journal'",[entity])).rows[0].next_number).toBe(before);
  expect((await post(source,key)).status).toBe("posted");
});
it("outbox insertion failure rolls back journal, number, source receipt and durable replay",async()=>{
  const source=await approved(),key=randomUUID(),client=await admin.connect();try{
    await client.query("BEGIN");await client.query("ALTER TABLE journal_posting_events ADD CONSTRAINT local_posting_fault CHECK(kind<>'journal.posted') NOT VALID");await client.query("COMMIT");
    await expect(post(source,key)).rejects.toThrow();
    for(const table of ['journal_entries','document_numbers','journal_source_postings','journal_posting_events','journal_posting_results'])expect((await admin.query(`SELECT * FROM ${table} WHERE source_id=$1`,[source])).rowCount).toBe(0);
  }finally{await client.query("ALTER TABLE journal_posting_events DROP CONSTRAINT IF EXISTS local_posting_fault");client.release();}
  expect((await post(source,key)).status).toBe("posted");
});
it("closed period denies new postings but not authorized committed replay",async()=>{
  const done=await approved(),key=randomUUID(),receipt=await post(done,key),fresh=await approved(),fixture=await admin.connect();
  try{await fixture.query("BEGIN");await fixture.query("ALTER TABLE fiscal_periods DISABLE TRIGGER fiscal_period_immutable");await fixture.query("UPDATE fiscal_periods SET state='hard_closed' WHERE id=$1",[period]);await fixture.query("ALTER TABLE fiscal_periods ENABLE TRIGGER fiscal_period_immutable");await fixture.query("COMMIT");
    await expect(post(fresh)).rejects.toMatchObject({code:"PERIOD_CLOSED"});expect(await post(done,key)).toEqual(receipt);expect(await post(done,randomUUID(),second)).toEqual(receipt);
  }finally{await fixture.query("BEGIN");await fixture.query("ALTER TABLE fiscal_periods DISABLE TRIGGER fiscal_period_immutable");await fixture.query("UPDATE fiscal_periods SET state='open' WHERE id=$1",[period]);await fixture.query("ALTER TABLE fiscal_periods ENABLE TRIGGER fiscal_period_immutable");await fixture.query("COMMIT");fixture.release();}
});
it("sources, decisions, events, receipts and responses are immutable even to owner",async()=>{
  for(const table of ['journal_posting_sources','journal_posting_decisions','journal_source_postings','journal_posting_events','journal_posting_results'])await expect(admin.query(`DELETE FROM ${table} WHERE organization_id=$1`,[org])).rejects.toThrow();
  const source=await approved();await expect(admin.query("UPDATE journal_posting_sources SET source_version=99 WHERE source_id=$1",[source])).rejects.toThrow();await expect(admin.query("UPDATE journal_posting_decisions SET reason='Forged review' WHERE command_id=(SELECT id FROM journal_posting_sources WHERE source_id=$1)",[source])).rejects.toThrow();
});
it("posting queued behind a closing transaction observes the closed period and creates no money",async()=>{
  const source=await approved(),fixture=await admin.connect();let pending:Promise<unknown>|undefined;
  try{
    await fixture.query("BEGIN");await fixture.query("SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE",[org]);
    await fixture.query("ALTER TABLE fiscal_periods DISABLE TRIGGER fiscal_period_immutable");await fixture.query("UPDATE fiscal_periods SET state='hard_closed' WHERE id=$1",[period]);await fixture.query("ALTER TABLE fiscal_periods ENABLE TRIGGER fiscal_period_immutable");
    let signal:(pid:number)=>void=()=>{};const entered=new Promise<number>(resolve=>{signal=resolve;});
    pending=withScope(poster,org,entity,"journals.post",async client=>{signal((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);return postAuthorizedJournalInTransaction(client,org,entity,source,1,randomUUID(),randomUUID());});
    const failure=expect(pending).rejects.toMatchObject({code:"PERIOD_CLOSED"}),pid=await entered;
    await expect.poll(async()=>(await admin.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.wait_event_type,{timeout:5000}).toBe("Lock");
    await fixture.query("COMMIT");await failure;
    expect((await admin.query("SELECT * FROM journal_source_postings WHERE source_id=$1",[source])).rowCount).toBe(0);
  }finally{await fixture.query("ROLLBACK");await pending?.catch(()=>{});await fixture.query("BEGIN");await fixture.query("ALTER TABLE fiscal_periods DISABLE TRIGGER fiscal_period_immutable");await fixture.query("UPDATE fiscal_periods SET state='open' WHERE id=$1",[period]);await fixture.query("ALTER TABLE fiscal_periods ENABLE TRIGGER fiscal_period_immutable");await fixture.query("COMMIT");fixture.release();}
});
it("direct runtime functions enforce scope, foreign-company 404 and missing-scope denial",async()=>{
  const source=await approved();await expect(postAuthorizedJournal(poster,org,foreignEntity,source,1,randomUUID(),randomUUID())).rejects.toMatchObject({status:404});
  const client=await databasePool().connect();try{
    expect((await client.query("SELECT * FROM journal_posting_sources")).rowCount).toBe(0);
    await expect(client.query("SELECT app_security.post_authorized_journal($1,$2,$3,1,$4,$5)",[org,entity,source,randomUUID(),randomUUID()])).rejects.toThrow(/FORBIDDEN/);
    await expect(client.query("SELECT app_security.approve_journal_posting_source($1,$2,$3,1,'Guess review',$4)",[org,entity,source,randomUUID()])).rejects.toThrow(/FORBIDDEN/);
    await expect(client.query("SELECT * FROM journal_posting_results")).rejects.toThrow(/permission denied/);
  }finally{client.release();}
});
it("entity-policy changes invalidate approvals and an uncovered date has no invented policy",async()=>{
  const source=await approved();await admin.query("UPDATE legal_entities SET version=version+1 WHERE id=$1",[entity]);
  try{await expect(post(source)).rejects.toMatchObject({code:"APPROVAL_INVALIDATED"});}finally{await admin.query("UPDATE legal_entities SET version=version-1 WHERE id=$1",[entity]);}
  await expect(prepare(randomUUID(),1,{...body(),postingDate:"2027-01-01"})).rejects.toMatchObject({code:"APPROVAL_POLICY_REQUIRED"});
});
it("branch edit racing posting is locked and invalidates before any ledger commit",async()=>{
  const source=await approved(),fixture=await admin.connect();let pending:Promise<unknown>|undefined;
  try{
    await fixture.query("BEGIN");await fixture.query("UPDATE branches SET name='Concurrent branch edit' WHERE id=$1",[branch]);
    let signal:(pid:number)=>void=()=>{};const entered=new Promise<number>(resolve=>{signal=resolve;});
    pending=withScope(poster,org,entity,"journals.post",async client=>{signal((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);return postAuthorizedJournalInTransaction(client,org,entity,source,1,randomUUID(),randomUUID());});
    const failure=expect(pending).rejects.toMatchObject({code:"APPROVAL_INVALIDATED"}),pid=await entered;
    await expect.poll(async()=>(await admin.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.wait_event_type,{timeout:5000}).toBe("Lock");
    await fixture.query("COMMIT");await failure;
    expect((await admin.query("SELECT id FROM journal_entries WHERE source_id=$1",[source])).rowCount).toBe(0);
  }finally{await fixture.query("ROLLBACK");await pending?.catch(()=>{});await fixture.query("UPDATE branches SET name='Prepared branch' WHERE id=$1",[branch]);fixture.release();}
});
it("effective mapping change invalidates earlier unposted sources and new sources retain revision",async()=>{
  const old=await approved(),accounts=new Map<string,string>();
  for(const [type,control]of Object.values(purposeRules))if(!accounts.has(`${type}|${control}`)){
    const created=await createAccount(poster,org,entity,{code:`PURPOSE-${accounts.size}`,name:`${type} ${control??"ordinary"}`,type:type as z.infer<typeof AccountType>,normalSide:["asset","expense"].includes(type)?"debit":"credit",isControl:control!==null,controlType:control as z.infer<typeof ControlType>|null,reportMapping:{statementSection:statementSections[type],cashFlowCategory:control==="cash"?"cash":"unclassified"}},randomUUID(),randomUUID());accounts.set(`${type}|${control}`,created.id);
  }
  const saved=await patchAccountMappings(poster,org,entity,{effectiveFrom:"2026-01-01",reason:"Reviewed complete mapping dependency",mappings:Object.entries(purposeRules).map(([purpose,[type,control]])=>({purpose:purpose as AccountPurpose,accountId:accounts.get(`${type}|${control}`)!}))},1,randomUUID());
  await expect(post(old)).rejects.toMatchObject({code:"APPROVAL_INVALIDATED"});
  const fresh=await approved();expect((await admin.query("SELECT mapping_revision_id FROM journal_posting_sources WHERE source_id=$1",[fresh])).rows[0].mapping_revision_id).toBe(saved.current!.id);
  expect((await post(fresh)).status).toBe("posted");
});
it("a renamed account invalidates approved source but never rewrites posted master versions",async()=>{
  const source=await approved();await patchAccount(poster,org,entity,expense,{name:"Changed protected account"},1,randomUUID());
  await expect(post(source)).rejects.toMatchObject({code:"APPROVAL_INVALIDATED"});
  expect((await admin.query("SELECT DISTINCT l.account_version,v.snapshot->>'name' AS name FROM journal_lines l JOIN account_versions v ON (v.organization_id,v.legal_entity_id,v.account_id,v.version)=(l.organization_id,l.legal_entity_id,l.account_id,l.account_version) WHERE l.organization_id=$1 AND l.account_id=$2",[org,expense])).rows).toEqual([{account_version:1,name:"expense"}]);
});
