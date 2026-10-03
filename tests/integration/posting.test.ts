import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { beforeAll, afterAll, expect, it } from "vitest";
import { databasePool } from "@/db/client";
import { withScope } from "@/features/identity/scope";
import { createAccount, patchAccount, archiveAccount } from "@/features/accounting/accounts-service";
import { createFiscalYear } from "@/features/accounting/setup-service";
import { writeManualJournal } from "@/features/accounting/posting-kernel";

config({ path: ".env.local", quiet: true });
const org = randomUUID(), entity = randomUUID(), other = randomUUID();
const finance = `posting-${randomUUID()}`, auditor = `posting-${randomUUID()}`;
const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
let debitAccount = "", creditAccount = "", controlAccount = "", branch = "", period = "", committed = "";
const input = () => ({ postingDate: "2026-10-03", documentDate: "2026-10-01", description: "Local internal kernel fixture", currency: "NPR", lines: [
  { accountId: debitAccount, accountVersion: 1, debit: "0.30", credit: "0.00", dimensions: { branchId: branch } },
  { accountId: creditAccount, accountVersion: 1, debit: "0.00", credit: "0.30", dimensions: {} },
] });
// Deliberately privileged test-only invocation. The web runtime cannot execute it.
async function internal<T>(run: (client: PoolClient) => Promise<T>, actor = finance, company = entity) {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id',$1,true),set_config('app.org_id',$2,true),set_config('app.entity_id',$3,true)", [actor, org, company]);
    const result = await run(client); await client.query("COMMIT"); return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
const post = (source = randomUUID(), value: unknown = input()) => internal(client => writeManualJournal(client, org, entity, source, value, randomUUID()));
const raw = (source: string, value: unknown) => internal(client => client.query("SELECT * FROM app_security.write_manual_journal($1,$2,$3,$4::jsonb,$5)", [org,entity,source,JSON.stringify(value),randomUUID()]));

beforeAll(async () => {
  const url = new URL(process.env.MIGRATION_DATABASE_URL ?? "");
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/kaamledger") throw new Error("Posting fixtures require the dedicated local database.");
  for (const id of [finance,auditor]) await admin.query("INSERT INTO auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Kernel fixture',$2,true,now(),now())", [id,`${id}@example.invalid`]);
  await admin.query("INSERT INTO organizations(id,name) VALUES($1,'Posting fixture')",[org]);
  for (const id of [entity,other]) await admin.query("INSERT INTO legal_entities(id,organization_id,name,active_modes,reporting_profile,created_by) VALUES($1,$2,'Kernel company','[\"labour\"]','demo_accrual',$3)",[id,org,finance]);
  for (const [id,role] of [[finance,"finance_manager"],[auditor,"auditor"]]) await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,$4,$5,'[]')",[randomUUID(),org,id,JSON.stringify([role]),JSON.stringify([entity])]);
  for (const [code,type,control] of [["EXP","expense",false],["EQ","equity",false],["CASH","asset",true]] as const) {
    const account = await createAccount(finance,org,entity,{code,name:code,type,normalSide:type==="equity"?"credit":"debit",isControl:control,controlType:control?"cash":null,reportMapping:{statementSection:type==="equity"?"equity":type==="expense"?"expenses":"assets",cashFlowCategory:control?"cash":"unclassified"}},randomUUID(),randomUUID());
    if(code==="EXP") debitAccount=account.id; else if(code==="EQ") creditAccount=account.id; else controlAccount=account.id;
  }
  const year = await createFiscalYear(finance,org,entity,{fiscalYearLabel:"Kernel year",retainedEarningsAccountId:creditAccount,periods:[{startDate:"2026-01-01",endDateExclusive:"2027-01-01"}]},randomUUID(),randomUUID());
  period=year.periods[0].id; branch=randomUUID();
  await admin.query("INSERT INTO branches(id,organization_id,legal_entity_id,name) VALUES($1,$2,$3,'Kernel branch')",[branch,org,entity]);
});
afterAll(async () => {
  const client=await admin.connect();
  const triggers=[["journal_lines","journal_line_immutable"],["journal_entries","journal_entry_immutable"],["document_numbers","document_number_immutable"],["document_series","document_series_no_delete"],["fiscal_periods","fiscal_period_immutable"],["fiscal_years","fiscal_year_immutable"],["account_versions","account_version_append_only"],["accounts","account_no_delete"],["audit_events","audit_append_only"]];
  try {
    await client.query("BEGIN"); for(const [table,trigger] of triggers) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    for(const table of ["journal_lines","journal_entries","document_numbers","document_series","fiscal_periods","fiscal_years","account_versions","accounts","branches","audit_events","idempotency_results","memberships","legal_entities"]) await client.query(`DELETE FROM ${table} WHERE organization_id=$1`,[org]);
    await client.query("DELETE FROM organizations WHERE id=$1",[org]); await client.query("DELETE FROM auth_user WHERE id=ANY($1::text[])",[[finance,auditor]]);
    for(const [table,trigger] of triggers) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`); await client.query("COMMIT");
  } catch(error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); await admin.end(); await databasePool().end(); }
});

it("concurrent same-source calls commit one journal, number, lines and audit",async()=>{
  const source=randomUUID(); const [a,b]=await Promise.all([post(source),post(source)]); expect(a).toEqual(b); committed=a.id;
  expect(a).toMatchObject({debit:"0.30",credit:"0.30"}); expect(a.number).toBe("JOURNAL-20260101-000001");
  expect((await admin.query("SELECT id FROM journal_entries WHERE source_id=$1",[source])).rowCount).toBe(1);
  expect((await admin.query("SELECT * FROM journal_lines WHERE journal_id=$1",[a.id])).rowCount).toBe(2);
  expect((await admin.query("SELECT id FROM document_numbers WHERE source_id=$1",[source])).rowCount).toBe(1);
  expect((await admin.query("SELECT id FROM audit_events WHERE target_id=$1",[a.id])).rowCount).toBe(1);
  await expect(post(source,{...input(),description:"Changed content"})).rejects.toThrow(/different content/);
});
it("different-source races retain distinct sequential numbers",async()=>{
  const receipts=await Promise.all(Array.from({length:4},()=>post()));
  expect(new Set(receipts.map(row=>row.number)).size).toBe(4);
  expect(receipts.map(row=>row.number).sort()).toEqual([2,3,4,5].map(n=>`JOURNAL-20260101-00000${n}`));
});
it("runtime cannot execute internal posting or mutate any journal table",async()=>{
  await expect(withScope(finance,org,entity,"journals.post",client=>writeManualJournal(client,org,entity,randomUUID(),input(),randomUUID()))).rejects.toThrow(/permission denied/);
  for(const query of ["DELETE FROM journal_entries WHERE id=$1","UPDATE journal_entries SET description='tampered' WHERE id=$1","DELETE FROM journal_lines WHERE journal_id=$1","INSERT INTO journal_entries(id) VALUES($1)","INSERT INTO journal_lines(journal_id) VALUES($1)","TRUNCATE journal_lines"]) {
    await expect(withScope(finance,org,entity,"journals.post",client=>client.query(query,query.includes("$1")?[committed]:[]))).rejects.toThrow(/permission denied/);
  }
});
it("scoped readers see only their company and lose access after revocation",async()=>{
  const rows=await withScope(auditor,org,entity,"journals.read",client=>client.query("SELECT total_debit,posting_date FROM journal_entries"));
  expect(rows.rowCount).toBe(5); expect(rows.rows[0]).toMatchObject({total_debit:"0.30",posting_date:"2026-10-03"});
  const client=await databasePool().connect();try{expect((await client.query("SELECT * FROM journal_entries")).rowCount).toBe(0);}finally{client.release();}
  await expect(withScope(auditor,org,other,"journals.read",client=>client.query("SELECT * FROM journal_lines"))).rejects.toMatchObject({status:404});
  await admin.query("UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2",[org,auditor]);
  try{await expect(withScope(auditor,org,entity,"journals.read",client=>client.query("SELECT * FROM journal_entries"))).rejects.toMatchObject({status:404});}finally{await admin.query("UPDATE memberships SET active=true WHERE organization_id=$1 AND user_id=$2",[org,auditor]);}
});
it("SQL itself rejects numeric JSON, precision loss, invalid dates and unsupported dimensions",async()=>{
  for (const amount of [1,"0.001","1e0","NaN","Infinity","-1.00","1000000000000000000.00"]) {
    const value=input(); await expect(raw(randomUUID(),{...value,lines:[{...value.lines[0],debit:amount},value.lines[1]]})).rejects.toThrow();
  }
  for(const patch of [{approved:true},{sourceType:"invoice"},{postingDate:"2026-02-30"},{currency:"USD"},{lines:null}]) await expect(raw(randomUUID(),{...input(),...patch})).rejects.toThrow();
  const value=input(); await expect(raw(randomUUID(),{...value,lines:[{...value.lines[0],dimensions:{workerId:randomUUID()}},value.lines[1]]})).rejects.toThrow(/dimension/);
  await expect(raw(randomUUID(),{...value,lines:[value.lines[0],{...value.lines[1],credit:"0.29"}]})).rejects.toThrow(/balance exactly/);
});
it("owner cannot change posted rows or append lines in a later transaction",async()=>{
  for(const query of ["UPDATE journal_entries SET description='Changed' WHERE id=$1","DELETE FROM journal_entries WHERE id=$1","UPDATE journal_lines SET debit=1 WHERE journal_id=$1","DELETE FROM journal_lines WHERE journal_id=$1"]) await expect(admin.query(query,[committed])).rejects.toThrow();
  await expect(internal(client=>client.query("INSERT INTO journal_lines(organization_id,legal_entity_id,journal_id,ordinal,account_id,account_version,debit,credit) VALUES($1,$2,$3,3,$4,1,1,0)",[org,entity,committed,debitAccount]))).rejects.toThrow(/cannot acquire/);
  await expect(archiveAccount(finance,org,entity,debitAccount,{reason:"Referenced journal account"},1,randomUUID(),randomUUID())).rejects.toThrow(/posted journal/);
});
it("deferred balance check rejects missing or imbalanced lines and rolls back numbers",async()=>{
  for(const credit of [null,"0.29"]) {
    const source=randomUUID();
    await expect(internal(async client=>{
      const receipt=await client.query("SELECT * FROM app_security.allocate_document_number($1,$2,'journal',$3,'post',DATE '2026-10-03')",[org,entity,source]);
      const id=randomUUID();
      await client.query("INSERT INTO journal_entries(id,organization_id,legal_entity_id,source_type,source_id,event_kind,status,posting_date,document_date,description,currency,number_id,number,fiscal_period_id,payload,total_debit,total_credit,created_by) VALUES($1,$2,$3,'journal',$4,'post','posted','2026-10-03','2026-10-01','Direct local fixture','NPR',$5,$6,$7,'{}',0.30,0.30,$8)",[id,org,entity,source,receipt.rows[0].id,receipt.rows[0].number,period,finance]);
      await client.query("INSERT INTO journal_lines(organization_id,legal_entity_id,journal_id,ordinal,account_id,account_version,debit,credit) VALUES($1,$2,$3,1,$4,1,0.30,0)",[org,entity,id,debitAccount]);
      if(credit!==null) await client.query("INSERT INTO journal_lines(organization_id,legal_entity_id,journal_id,ordinal,account_id,account_version,debit,credit) VALUES($1,$2,$3,2,$4,1,0,$5)",[org,entity,id,creditAccount,credit]);
    })).rejects.toThrow(/exact debit\/credit balance/);
    expect((await admin.query("SELECT * FROM document_numbers WHERE source_id=$1",[source])).rowCount).toBe(0);
  }
});
it("downstream failure rolls back journal, lines, audit, receipt and sequence together",async()=>{
  const source=randomUUID(); const before=(await admin.query("SELECT next_number FROM document_series WHERE legal_entity_id=$1 AND document_type='journal'",[entity])).rows[0].next_number;
  const audits=(await admin.query("SELECT count(*) FROM audit_events WHERE organization_id=$1",[org])).rows[0].count;
  const lines=(await admin.query("SELECT count(*) FROM journal_lines WHERE organization_id=$1",[org])).rows[0].count;
  await expect(internal(async client=>{await writeManualJournal(client,org,entity,source,input(),randomUUID());throw new Error("Injected downstream source failure");})).rejects.toThrow(/Injected/);
  expect((await admin.query("SELECT id FROM journal_entries WHERE source_id=$1",[source])).rowCount).toBe(0);
  expect((await admin.query("SELECT id FROM document_numbers WHERE source_id=$1",[source])).rowCount).toBe(0);
  expect((await admin.query("SELECT next_number FROM document_series WHERE legal_entity_id=$1 AND document_type='journal'",[entity])).rows[0].next_number).toBe(before);
  expect((await admin.query("SELECT count(*) FROM audit_events WHERE organization_id=$1",[org])).rows[0].count).toBe(audits);
  expect((await admin.query("SELECT count(*) FROM journal_lines WHERE organization_id=$1",[org])).rows[0].count).toBe(lines);
});
it("account/control/branch failures after numbering also roll back the entire write",async()=>{
  for(const patch of [{accountId:controlAccount},{accountId:randomUUID()},{accountVersion:2},{dimensions:{branchId:randomUUID()}}]) {
    const source=randomUUID(),value=input();
    await expect(post(source,{...value,lines:[{...value.lines[0],...patch},value.lines[1]]})).rejects.toThrow();
    expect((await admin.query("SELECT id FROM document_numbers WHERE source_id=$1",[source])).rowCount).toBe(0);
    expect((await admin.query("SELECT id FROM journal_entries WHERE source_id=$1",[source])).rowCount).toBe(0);
  }
});
it("closed periods, revoked writers, cross-company authority and live policy fail closed",async()=>{
  await expect(internal(client=>writeManualJournal(client,org,other,randomUUID(),input(),randomUUID()))).rejects.toThrow(/authority/);
  await expect(internal(client=>writeManualJournal(client,org,entity,randomUUID(),input(),randomUUID()),auditor)).rejects.toThrow(/authority/);
  await admin.query("UPDATE legal_entities SET policy_status='live' WHERE id=$1",[entity]);
  try{await expect(post()).rejects.toThrow(/unsupported live policy/);}finally{await admin.query("UPDATE legal_entities SET policy_status='demo' WHERE id=$1",[entity]);}
  const fixture=await admin.connect();try{
    await fixture.query("BEGIN");await fixture.query("ALTER TABLE fiscal_periods DISABLE TRIGGER fiscal_period_immutable");await fixture.query("UPDATE fiscal_periods SET state='hard_closed' WHERE id=$1",[period]);await fixture.query("ALTER TABLE fiscal_periods ENABLE TRIGGER fiscal_period_immutable");await fixture.query("COMMIT");
    await expect(post()).rejects.toThrow(/open fiscal period/);
  }finally{await fixture.query("BEGIN");await fixture.query("ALTER TABLE fiscal_periods DISABLE TRIGGER fiscal_period_immutable");await fixture.query("UPDATE fiscal_periods SET state='open' WHERE id=$1",[period]);await fixture.query("ALTER TABLE fiscal_periods ENABLE TRIGGER fiscal_period_immutable");await fixture.query("COMMIT");fixture.release();}
});
it("branch references cannot be deleted or moved to another company after posting",async()=>{
  await expect(admin.query("DELETE FROM branches WHERE id=$1",[branch])).rejects.toThrow(/foreign key/);
  await expect(admin.query("UPDATE branches SET legal_entity_id=$2 WHERE id=$1",[branch,other])).rejects.toThrow(/foreign key/);
});
it("current authority is checked before source replay and missing transaction scope is denied",async()=>{
  const source=(await admin.query("SELECT source_id FROM journal_entries WHERE id=$1",[committed])).rows[0].source_id;
  await admin.query("UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2",[org,finance]);
  try{await expect(post(source)).rejects.toThrow(/authority/);}finally{await admin.query("UPDATE memberships SET active=true WHERE organization_id=$1 AND user_id=$2",[org,finance]);}
  await expect(admin.query("SELECT * FROM app_security.write_manual_journal($1,$2,$3,$4::jsonb,'unscoped')",[org,entity,randomUUID(),JSON.stringify(input())])).rejects.toThrow(/authority/);
});
it("raw SQL protects bounded line counts, two-sided lines and total money overflow",async()=>{
  const value=input();
  for(const lines of [[],[value.lines[0]],Array.from({length:501},()=>value.lines[0]),[{...value.lines[0],credit:"0.30"},value.lines[1]],
    [{...value.lines[0],debit:"999999999999999999.99"},{...value.lines[1],credit:"999999999999999999.99"},...value.lines]]) {
    await expect(raw(randomUUID(),{...value,lines})).rejects.toThrow();
  }
});
it("renaming a master preserves retained journal version and rejects stale new posting",async()=>{
  await patchAccount(finance,org,entity,debitAccount,{name:"Current renamed expense"},1,randomUUID());
  const retained=await admin.query("SELECT l.account_version,v.snapshot->>'name' AS name FROM journal_lines l JOIN account_versions v ON (v.organization_id,v.legal_entity_id,v.account_id,v.version)=(l.organization_id,l.legal_entity_id,l.account_id,l.account_version) WHERE l.journal_id=$1 AND l.account_id=$2",[committed,debitAccount]);
  expect(retained.rows).toEqual([{account_version:1,name:"EXP"}]);
  await expect(post()).rejects.toThrow(/current ordinary account version/);
});
