import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, expect, it } from "vitest";
import { databasePool } from "@/db/client";
import { withScope } from "@/features/identity/scope";
import { createAccount, archiveAccount, patchAccount } from "@/features/accounting/accounts-service";
import { createFiscalYear, listFiscalYears, listPeriods, getPeriod, getAccountMappings, patchAccountMappings, resolveAccountPurpose, allocateDocumentNumber } from "@/features/accounting/setup-service";
import { purposeRules, type AccountPurpose } from "@/domain/finance-setup";
import { statementSections, type AccountType, type ControlType } from "@/domain/accounts";
import type { z } from "zod";
config({ path: ".env.local", quiet: true });
const org = randomUUID(), foreignOrg = randomUUID(), entity = randomUUID(), foreignEntity = randomUUID(), finance = `setup-${randomUUID()}`, reader = `setup-${randomUUID()}`, owner = `setup-${randomUUID()}`;
const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const accountIds = new Map<string, string>(); let retained = "", baseYearId = "";
const scope = <T>(run: (client: import("pg").PoolClient) => Promise<T>) => withScope(finance, org, entity, "periods.create", run);
const yearInput = (label: string, start: string, end: string) => ({ fiscalYearLabel: label, retainedEarningsAccountId: retained, periods: [{ startDate: start, endDateExclusive: end }] });
const mappingInput = (effectiveFrom: string) => ({ effectiveFrom, reason: "Reviewed complete R1 purpose mapping", mappings: Object.entries(purposeRules).map(([purpose, [type, control]]) => ({ purpose: purpose as AccountPurpose, accountId: accountIds.get(`${type}|${control}`)! })) });
beforeAll(async () => {
  const url = new URL(process.env.MIGRATION_DATABASE_URL ?? ""); if (url.hostname !== "127.0.0.1" || url.pathname !== "/kaamledger") throw new Error("Setup fixtures require the dedicated local database.");
  for (const id of [finance, reader, owner]) await admin.query("INSERT INTO auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Setup fixture',$2,true,now(),now())", [id, `${id}@example.invalid`]);
  await admin.query("INSERT INTO organizations(id,name) VALUES($1,'Finance setup A'),($2,'Finance setup B')", [org, foreignOrg]);
  for (const [id, parent] of [[entity,org],[foreignEntity,foreignOrg]]) await admin.query("INSERT INTO legal_entities(id,organization_id,name,active_modes,reporting_profile,created_by) VALUES($1,$2,'Setup company','[\"labour\"]','demo_accrual',$3)", [id,parent,finance]);
  for (const [id, role] of [[finance,"finance_manager"],[reader,"auditor"],[owner,"organization_admin"]]) await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,$4,$5,'[]')", [randomUUID(),org,id,JSON.stringify([role]),JSON.stringify([entity])]);
  for (const [type,control] of Object.values(purposeRules)) if (!accountIds.has(`${type}|${control}`)) {
    const account = await createAccount(finance,org,entity,{code:`SETUP-${accountIds.size}`,name:`${type} ${control ?? "ordinary"}`,type:type as z.infer<typeof AccountType>,normalSide:["asset","expense"].includes(type)?"debit":"credit",isControl:control!==null,controlType:control as z.infer<typeof ControlType>|null,reportMapping:{statementSection:statementSections[type],cashFlowCategory:control==="cash"?"cash":"unclassified"}},randomUUID(),randomUUID());
    accountIds.set(`${type}|${control}`,account.id);
  }
  retained=accountIds.get("equity|null")!;
  const year = await createFiscalYear(finance,org,entity,{...yearInput("Explicit calendar","2026-01-01","2027-01-01"),periods:[{startDate:"2026-01-01",endDateExclusive:"2026-07-01"},{startDate:"2026-07-01",endDateExclusive:"2027-01-01"}]},randomUUID(),randomUUID()); baseYearId=year.id;
});
afterAll(async () => {
  const client=await admin.connect(); const triggers=[["document_numbers","document_number_immutable"],["document_series","document_series_no_delete"],["account_mapping_entries","mapping_entry_immutable"],["account_mapping_revisions","mapping_revision_immutable"],["fiscal_periods","fiscal_period_immutable"],["fiscal_years","fiscal_year_immutable"],["account_versions","account_version_append_only"],["accounts","account_no_delete"],["audit_events","audit_append_only"]];
  try {
    await client.query("BEGIN"); for(const [table,trigger] of triggers) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    for(const table of ["document_numbers","document_series","account_mapping_entries","account_mapping_revisions","fiscal_periods","fiscal_years","account_versions","accounts","audit_events","idempotency_results","memberships","legal_entities"]) await client.query(`DELETE FROM ${table} WHERE organization_id=ANY($1::uuid[])`,[[org,foreignOrg]]);
    await client.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])",[[org,foreignOrg]]); await client.query("DELETE FROM auth_user WHERE id=ANY($1::text[])",[[finance,reader,owner]]);
    for(const [table,trigger] of triggers) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`); await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();await admin.end();await databasePool().end();}
});
it("concurrent calendar create replay commits one year, periods, series and audit",async()=>{
  const input=yearInput("Next calendar","2027-01-01","2028-01-01"),key=randomUUID();
  const [a,b]=await Promise.all([createFiscalYear(finance,org,entity,input,key,randomUUID()),createFiscalYear(finance,org,entity,input,key,randomUUID())]);
  expect(a).toEqual(b); expect(a.documentSeries).toHaveLength(11); expect(a.documentSeries.every(s=>s.nextNumber==="1")).toBe(true);
  expect((await admin.query("SELECT id FROM audit_events WHERE target_id=$1",[a.id])).rowCount).toBe(1);
  await expect(createFiscalYear(finance,org,entity,{...input,fiscalYearLabel:"Changed"},key,randomUUID())).rejects.toMatchObject({status:409});
});
it("duplicate label and overlapping calendars lose races; adjacent intervals are valid",async()=>{
  await expect(createFiscalYear(finance,org,entity,yearInput(" EXPLICIT CALENDAR ","2030-01-01","2031-01-01"),randomUUID(),randomUUID())).rejects.toMatchObject({status:409});
  const results=await Promise.allSettled([createFiscalYear(finance,org,entity,yearInput("Race A","2030-01-01","2031-01-01"),randomUUID(),randomUUID()),createFiscalYear(finance,org,entity,yearInput("Race B","2030-06-01","2031-06-01"),randomUUID(),randomUUID())]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1); expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);
});
it("calendar reads preserve DATE strings, paginate and deny cross scope or ordinary admin creation",async()=>{
  const years=await listFiscalYears(reader,org,entity,1); expect(years.data).toHaveLength(1); expect(years.nextCursor).toBeTruthy();
  const periods=await listPeriods(reader,org,entity,1); expect(periods.nextCursor).toBeTruthy(); expect((await getPeriod(reader,org,entity,periods.data[0].id)).startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await expect(getPeriod(reader,org,entity,randomUUID())).rejects.toMatchObject({status:404});
  await expect(listPeriods(reader,foreignOrg,foreignEntity,10)).rejects.toMatchObject({status:404});
  await expect(createFiscalYear(owner,org,entity,yearInput("Denied","2040-01-01","2041-01-01"),randomUUID(),randomUUID())).rejects.toMatchObject({status:403});
  const empty=await getAccountMappings(owner,org,entity); expect(empty.version).toBe(1);expect(empty.latest).toBeNull();
});
it("SQL cannot commit incomplete or overlapping period coverage or mutate saved calendar",async()=>{
  await expect(scope(async client=>{
    await client.query("INSERT INTO fiscal_years(id,organization_id,legal_entity_id,label,start_date,end_date_exclusive,period_count,retained_earnings_account_id,retained_earnings_account_version,created_by) VALUES($1,$2,$3,'Incomplete',DATE '2040-01-01',DATE '2041-01-01',1,$4,1,$5)",[randomUUID(),org,entity,retained,finance]);
  })).rejects.toThrow(/completely/);
  await expect(scope(client=>client.query("UPDATE fiscal_years SET label='Mutated' WHERE id=$1",[baseYearId]))).rejects.toThrow();
  await expect(scope(client=>client.query("UPDATE fiscal_periods SET state='hard_closed' WHERE fiscal_year_id=$1",[baseYearId]))).rejects.toThrow();
  await expect(archiveAccount(finance,org,entity,retained,{reason:"Referenced retained account"},1,randomUUID(),randomUUID())).rejects.toThrow(/required/);
});
it("deferred calendar checks reject complete-count gaps and overlaps and roll back every series",async()=>{
  for (const boundary of ["2045-06-30","2045-07-02"]) {
    const year=randomUUID();
    await expect(scope(async client=>{
      await client.query("INSERT INTO fiscal_years(id,organization_id,legal_entity_id,label,start_date,end_date_exclusive,period_count,retained_earnings_account_id,retained_earnings_account_version,created_by) VALUES($1,$2,$3,$4,DATE '2045-01-01',DATE '2046-01-01',2,$5,1,$6)",[year,org,entity,`Boundary ${boundary}`,retained,finance]);
      for (const [ordinal,start,end] of [[1,"2045-01-01","2045-07-01"],[2,boundary,"2046-01-01"]]) await client.query("INSERT INTO fiscal_periods(id,organization_id,legal_entity_id,fiscal_year_id,ordinal,start_date,end_date_exclusive,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[randomUUID(),org,entity,year,ordinal,start,end,finance]);
    })).rejects.toThrow(/contiguously/);
    for (const table of ["fiscal_periods","document_series"]) expect((await admin.query(`SELECT * FROM ${table} WHERE fiscal_year_id=$1`,[year])).rowCount).toBe(0);
    expect((await admin.query("SELECT id FROM fiscal_years WHERE id=$1",[year])).rowCount).toBe(0);
  }
});
it("complete mappings snapshot exact account versions and reject wrong controls, foreign IDs and revoked authority",async()=>{
  const bad=mappingInput("2026-01-01"); bad.mappings[0].accountId=retained;
  await expect(patchAccountMappings(finance,org,entity,bad,1,randomUUID())).rejects.toMatchObject({code:"INVALID_ACCOUNT_MAPPING"});
  bad.mappings[0].accountId=randomUUID(); await expect(patchAccountMappings(finance,org,entity,bad,1,randomUUID())).rejects.toMatchObject({status:404});
  await expect(patchAccountMappings(reader,org,entity,mappingInput("2026-01-01"),1,randomUUID())).rejects.toMatchObject({status:403});
  const result=await patchAccountMappings(finance,org,entity,mappingInput("2026-01-01"),1,randomUUID()); expect(result.version).toBe(2);expect(result.current?.mappings).toHaveLength(26);
  const adminView=await getAccountMappings(owner,org,entity); expect(adminView.current?.mappings).toHaveLength(26);
  const resolved=await scope(client=>resolveAccountPurpose(client,org,entity,"2026-01-01","ar"));expect(resolved.mappingVersion).toBe(2);expect(resolved.accountVersion).toBe(1);
  await expect(scope(client=>resolveAccountPurpose(client,org,entity,"2025-12-31","ar"))).rejects.toMatchObject({code:"ACCOUNT_MAPPING_REQUIRED"});
});
it("concurrent mapping edits have one winner; future versions never overwrite effective history",async()=>{
  const results=await Promise.allSettled([patchAccountMappings(finance,org,entity,mappingInput("2028-01-01"),2,randomUUID()),patchAccountMappings(finance,org,entity,mappingInput("2029-01-01"),2,randomUUID())]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.find(r=>r.status==="rejected")).toMatchObject({reason:{status:412}});
  const result=await getAccountMappings(reader,org,entity);expect(result.version).toBe(3);expect(result.current?.version).toBe(2);expect(result.latest?.version).toBe(3);
  await expect(patchAccountMappings(finance,org,entity,mappingInput("2026-01-02"),3,randomUUID())).rejects.toMatchObject({status:409});
  const ar=accountIds.get("asset|ar")!; await patchAccount(finance,org,entity,ar,{name:"Renamed AR"},1,randomUUID());
  expect((await getAccountMappings(finance,org,entity)).current?.mappings.find(m=>m.purpose==="ar")?.accountVersion).toBe(1);
  await expect(archiveAccount(finance,org,entity,ar,{reason:"Still mapped"},2,randomUUID(),randomUUID())).rejects.toThrow(/required/);
});
it("direct SQL cannot commit incomplete mappings or rewrite preserved entries",async()=>{
  await expect(scope(client=>client.query("INSERT INTO account_mapping_revisions(id,organization_id,legal_entity_id,version,effective_from,reason,created_by) VALUES($1,$2,$3,4,DATE '2035-01-01','Incomplete mapping',$4)",[randomUUID(),org,entity,finance]))).rejects.toThrow(/Incomplete/);
  await expect(scope(client=>client.query("UPDATE account_mapping_entries SET account_version=99 WHERE organization_id=$1",[org]))).rejects.toThrow();
  expect((await admin.query("SELECT purpose,account_type,control_type FROM account_purposes ORDER BY purpose")).rows).toEqual(Object.entries(purposeRules).sort(([a],[b])=>a.localeCompare(b)).map(([purpose,[account_type,control_type]])=>({purpose,account_type,control_type})));
});
it("number allocations serialize, return one source receipt and distinguish document series",async()=>{
  const sourceId=randomUUID(),input={documentType:"journal" as const,sourceId,eventKind:"post" as const,postingDate:"2026-01-01"};
  const [a,b]=await Promise.all([scope(client=>allocateDocumentNumber(client,org,entity,input)),scope(client=>allocateDocumentNumber(client,org,entity,input))]); expect(a).toEqual(b);expect(a.number).toBe("JOURNAL-20260101-000001");expect(a.sequenceNumber).toBe("1");
  const distinct=await Promise.all(Array.from({length:4},()=>scope(client=>allocateDocumentNumber(client,org,entity,{...input,sourceId:randomUUID()})))); expect(new Set(distinct.map(r=>r.number)).size).toBe(4);
  const invoice=await scope(client=>allocateDocumentNumber(client,org,entity,{...input,documentType:"invoice",sourceId:randomUUID()}));expect(invoice.sequenceNumber).toBe("1");
  await expect(scope(client=>allocateDocumentNumber(client,org,entity,{...input,postingDate:"2026-01-02"}))).rejects.toThrow(/another posting date/);
});
it("number and counter roll back together; exclusive boundary chooses the next fiscal year",async()=>{
  const input={documentType:"expense" as const,sourceId:randomUUID(),eventKind:"post" as const,postingDate:"2026-12-31"};
  await expect(scope(async client=>{await allocateDocumentNumber(client,org,entity,input);throw new Error("Injected posting failure");})).rejects.toThrow(/Injected/);
  const number=await scope(client=>allocateDocumentNumber(client,org,entity,input));expect(number.sequenceNumber).toBe("1");
  const next=await scope(client=>allocateDocumentNumber(client,org,entity,{...input,sourceId:randomUUID(),postingDate:"2027-01-01"}));expect(next.fiscalYearId).not.toBe(baseYearId);expect(next.sequenceNumber).toBe("1");
  await expect(scope(client=>allocateDocumentNumber(client,org,entity,{...input,sourceId:randomUUID(),postingDate:"2025-12-31"}))).rejects.toThrow(/open fiscal period/);
});
it("restricted SQL rejects unscoped numbering, forged counters, receipt mutation and cross-company input",async()=>{
  const client=await databasePool().connect();try{
    expect((await client.query("SELECT * FROM fiscal_years")).rowCount).toBe(0);expect((await client.query("SELECT * FROM document_numbers")).rowCount).toBe(0);
    await client.query("BEGIN");await client.query("SELECT set_config('app.user_id',$1,true)",[finance]);
    await expect(client.query("SELECT * FROM app_security.allocate_document_number($1,$2,'journal',$3,'post',DATE '2026-01-01')",[org,entity,randomUUID()])).rejects.toThrow(/authority/);await client.query("ROLLBACK");
  }finally{client.release();}
  await expect(scope(client=>client.query("UPDATE document_series SET next_number=1 WHERE organization_id=$1",[org]))).rejects.toThrow();
  await expect(scope(client=>client.query("DELETE FROM document_numbers WHERE organization_id=$1",[org]))).rejects.toThrow();
  await expect(scope(client=>allocateDocumentNumber(client,org,foreignEntity,{documentType:"journal",sourceId:randomUUID(),eventKind:"post",postingDate:"2026-01-01"}))).rejects.toThrow(/authority/);
  await admin.query("UPDATE memberships SET roles='[\"accountant\"]' WHERE organization_id=$1 AND user_id=$2",[org,finance]);
  try{await expect(patchAccountMappings(finance,org,entity,mappingInput("2035-01-01"),3,randomUUID())).rejects.toMatchObject({status:403});}finally{await admin.query("UPDATE memberships SET roles='[\"finance_manager\"]' WHERE organization_id=$1 AND user_id=$2",[org,finance]);}
});
it("closed periods deny fresh numbers while committed receipt replay remains immutable",async()=>{
  const input={documentType:"transfer" as const,sourceId:randomUUID(),eventKind:"post" as const,postingDate:"2026-02-01"};
  const receipt=await scope(client=>allocateDocumentNumber(client,org,entity,input));
  const fixture=await admin.connect();
  try {
    // Local fixture state only; no closing command is exposed by this work package.
    await fixture.query("BEGIN"); await fixture.query("ALTER TABLE fiscal_periods DISABLE TRIGGER fiscal_period_immutable");
    await fixture.query("UPDATE fiscal_periods SET state='hard_closed' WHERE fiscal_year_id=$1 AND ordinal=1",[baseYearId]);
    await fixture.query("ALTER TABLE fiscal_periods ENABLE TRIGGER fiscal_period_immutable"); await fixture.query("COMMIT");
    expect(await scope(client=>allocateDocumentNumber(client,org,entity,input))).toEqual(receipt);
    await expect(scope(client=>allocateDocumentNumber(client,org,entity,{...input,sourceId:randomUUID()}))).rejects.toThrow(/open fiscal period/);
    await expect(admin.query("UPDATE document_numbers SET number='REWRITTEN' WHERE id=$1",[receipt.id])).rejects.toMatchObject({code:"P0001"});
  } finally {
    await fixture.query("ROLLBACK"); await fixture.query("BEGIN"); await fixture.query("ALTER TABLE fiscal_periods DISABLE TRIGGER fiscal_period_immutable");
    await fixture.query("UPDATE fiscal_periods SET state='open' WHERE fiscal_year_id=$1 AND ordinal=1",[baseYearId]);
    await fixture.query("ALTER TABLE fiscal_periods ENABLE TRIGGER fiscal_period_immutable"); await fixture.query("COMMIT"); fixture.release();
  }
});
it("archive racing a new mapping cannot leave a current or future purpose on an inactive account",async()=>{
  const account=await createAccount(finance,org,entity,{code:"RACE-EXPENSE",name:"Race expense",type:"expense",normalSide:"debit",isControl:false,controlType:null,reportMapping:{statementSection:"expenses",cashFlowCategory:"unclassified"}},randomUUID(),randomUUID());
  const input=mappingInput("2090-01-01"); input.mappings.find(entry=>entry.purpose==="expense")!.accountId=account.id;
  const results=await Promise.allSettled([patchAccountMappings(finance,org,entity,input,3,randomUUID()),archiveAccount(finance,org,entity,account.id,{reason:"Retired before use"},1,randomUUID(),randomUUID())]);
  expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);
  expect((await admin.query("SELECT 1 FROM account_mapping_entries e JOIN accounts a ON a.id=e.account_id WHERE e.account_id=$1 AND NOT a.active",[account.id])).rowCount).toBe(0);
});
