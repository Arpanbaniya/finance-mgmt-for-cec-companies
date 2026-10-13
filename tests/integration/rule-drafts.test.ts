import { config } from "dotenv";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, expect, it } from "vitest";
import { databasePool } from "@/db/client";
import { withScope } from "@/features/identity/scope";
import { createRuleDraft, getRuleDraft, listRuleDrafts, checkTaxRuleAvailability } from "@/features/rules/service";
import type { TaxRuleInput } from "@/domain/tax-rules";
import { requestRuleEvidenceUpload, getPendingDocument } from "@/features/documents/service";
import { storageConfig } from "@/features/documents/storage-config";
config({ path: ".env.local", quiet: true });
const org = randomUUID(), foreignOrg = randomUUID(), entity = randomUUID(), other = randomUUID(), live = randomUUID(), foreignEntity = randomUUID();
const finance = `rule-${randomUUID()}`, reader = `rule-${randomUUID()}`, reviewer = `rule-${randomUUID()}`, owner = `rule-${randomUUID()}`, administrator = `rule-${randomUUID()}`, outsider = `rule-${randomUUID()}`;
const users = [finance, reader, reviewer, owner, administrator, outsider], admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
function guard() { for (const connection of [process.env.MIGRATION_DATABASE_URL, process.env.DATABASE_URL]) { const url = new URL(connection ?? ""); if (url.hostname !== "127.0.0.1" || url.pathname !== "/kaamledger" || url.port !== (process.env.GITHUB_ACTIONS === "true" ? "5432" : "55432")) throw new Error("Rule fixtures require the dedicated local database."); } }
const input = (): TaxRuleInput => ({ kind: "sales_tax", applicability: { event: "invoice", taxCode: "DEMO_OUTPUT" }, effectiveFrom: "2026-01-01", effectiveTo: "2027-01-01", definition: { method: "percentage", rate: "10", basis: "exclusive", rounding: "half_up_line", inputCredit: "not_applicable" }, sourceReferences: [{ title: "Synthetic fixture, not law", url: "https://example.invalid/rules", section: "Fixture A", sha256: "b".repeat(64) }], demoOnly: true });
const create = (command = input(), company = entity, key = randomUUID()) => createRuleDraft(finance, org, company, command, key, randomUUID());
const storageKeys = ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;
const originalStorage = Object.fromEntries(storageKeys.map(name => [name, process.env[name]]));
const uploadInput = (ownerId: string) => ({ filename: "Synthetic-source.pdf", contentType: "application/pdf" as const, sizeBytes: 100, sha256: "b".repeat(64), sensitivity: "internal" as const, ownerType: "rule_version" as const, ownerId });
const upload = (ownerId: string, key = randomUUID()) => requestRuleEvidenceUpload(finance, org, entity, uploadInput(ownerId), key, randomUUID());
beforeAll(async () => {
  guard();
  // Signing does not contact this endpoint. Provider enforcement is tested by
  // the separate real-storage suite; never reuse deployed credentials here.
  Object.assign(process.env, { S3_ENDPOINT: "http://127.0.0.1:58080", S3_REGION: "us-east-1", S3_BUCKET: `request-${randomUUID()}`, S3_ACCESS_KEY_ID: randomBytes(16).toString("hex"), S3_SECRET_ACCESS_KEY: randomBytes(32).toString("hex") });
  storageConfig();
  for (const id of users) await admin.query("INSERT INTO auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Rule fixture',$2,true,now(),now())", [id, `${id}@example.invalid`]);
  await admin.query("INSERT INTO organizations(id,name) VALUES($1,'Rules A'),($2,'Rules B')", [org, foreignOrg]);
  for (const [id, organization, actor] of [[entity, org, finance], [other, org, finance], [foreignEntity, foreignOrg, outsider]]) await admin.query("INSERT INTO legal_entities(id,organization_id,name,active_modes,reporting_profile,created_by) VALUES($1,$2,'Synthetic rules company','[\"labour\"]','demo_accrual',$3)", [id, organization, actor]);
  await admin.query("INSERT INTO legal_entities(id,organization_id,name,active_modes,reporting_profile,policy_status,created_by) VALUES($1,$2,'Review required company','[\"labour\"]','review_required','review_required',$3)", [live, org, finance]);
  for (const [user, role] of [[finance, "finance_manager"], [reader, "accountant"], [reviewer, "policy_reviewer"], [owner, "owner"], [administrator, "organization_admin"]]) await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,$4,$5,'[]')", [randomUUID(), org, user, JSON.stringify([role]), JSON.stringify([entity, other, live])]);
  await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids) VALUES($1,$2,$3,'[\"finance_manager\"]',$4,'[]')", [randomUUID(), foreignOrg, outsider, JSON.stringify([foreignEntity])]);
});
afterAll(async () => {
  guard(); const client = await admin.connect();
  try {
    await client.query("BEGIN"); await client.query("ALTER TABLE rule_versions DISABLE TRIGGER rule_immutable"); await client.query("ALTER TABLE audit_events DISABLE TRIGGER audit_append_only"); await client.query("ALTER TABLE rule_evidence_requests DISABLE TRIGGER rule_evidence_immutable");
    for (const table of ["rule_evidence_requests", "rule_versions", "audit_events", "idempotency_results", "memberships", "legal_entities"]) await client.query(`DELETE FROM ${table} WHERE organization_id=ANY($1::uuid[])`, [[org, foreignOrg]]);
    await client.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [[org, foreignOrg]]); await client.query("DELETE FROM auth_user WHERE id=ANY($1::text[])", [users]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE"); await client.query("ALTER TABLE rule_versions ENABLE TRIGGER rule_immutable"); await client.query("ALTER TABLE audit_events ENABLE TRIGGER audit_append_only"); await client.query("ALTER TABLE rule_evidence_requests ENABLE TRIGGER rule_evidence_immutable"); await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); await admin.end(); await databasePool().end(); for (const name of storageKeys) { if (originalStorage[name] === undefined) delete process.env[name]; else process.env[name] = originalStorage[name]; } }
});
it("persists immutable scoped draft metadata, sources and a database-owned hash", async () => {
  const draft = await create();
  expect(await getRuleDraft(reviewer, org, entity, draft.id)).toEqual(draft);
  expect(draft).toMatchObject({ status: "draft", version: 1, jurisdiction: "NP", currency: "NPR", evaluatorVersion: "tax-line-v1", createdBy: finance, demoOnly: true });
  expect((await admin.query("SELECT content_hash=encode(sha256(convert_to(definition::text,'UTF8')),'hex') AS matches FROM rule_versions WHERE id=$1", [draft.id])).rows[0].matches).toBe(true);
});
it("serializes concurrent replay, returns the original receipt and binds the payload", async () => {
  const key = randomUUID(), command = input(), [a, b] = await Promise.all([create(command, entity, key), create(command, entity, key)]);
  expect(a).toEqual(b); await expect(create({ ...command, effectiveFrom: "2026-02-01" }, entity, key)).rejects.toMatchObject({ status: 409 });
  expect((await admin.query("SELECT id FROM audit_events WHERE target_id=$1 AND action='rule.create'", [a.id])).rowCount).toBe(1);
  expect((await admin.query("SELECT id FROM rule_versions WHERE id=$1", [a.id])).rowCount).toBe(1);
});
it("denies owner/admin escalation, reader writes and guessed entity/organization reads", async () => {
  const draft = await create();
  for (const user of [reader, reviewer, owner, administrator]) await expect(createRuleDraft(user, org, entity, input(), randomUUID(), randomUUID())).rejects.toMatchObject({ status: 403 });
  for (const user of [owner, administrator]) {
    await expect(getRuleDraft(user, org, entity, draft.id)).rejects.toMatchObject({ status: 403 });
    expect(await withScope(user, org, entity, "entity.read", async c => (await c.query("SELECT id FROM rule_versions WHERE id=$1", [draft.id])).rowCount)).toBe(0);
  }
  await expect(getRuleDraft(outsider, org, entity, draft.id)).rejects.toMatchObject({ status: 404 });
  await expect(getRuleDraft(finance, org, other, draft.id)).rejects.toMatchObject({ status: 404 });
  expect(await withScope(finance, org, other, "rules.read", async c => (await c.query("SELECT id FROM rule_versions WHERE id=$1", [draft.id])).rowCount)).toBe(0);
});
it("refuses synthetic drafts in review-required companies; live drafts remain unverified", async () => {
  await expect(create(input(), live)).rejects.toMatchObject({ code: "DEMO_RULE_FORBIDDEN" });
  expect(await create({ ...input(), demoOnly: false }, live)).toMatchObject({ demoOnly: false, status: "draft", version: 1 });
  expect((await admin.query("SELECT policy_status FROM legal_entities WHERE id=$1", [live])).rows[0].policy_status).toBe("review_required");
});
it("denies raw runtime mutation and protects retained definitions even from owner SQL", async () => {
  const draft = await create();
  for (const sql of ["UPDATE rule_versions SET definition='{}' WHERE id=$1", "DELETE FROM rule_versions WHERE id=$1"]) {
    await expect(withScope(finance, org, entity, "rules.read", c => c.query(sql, [draft.id]))).rejects.toMatchObject({ code: "42501" });
    await expect(admin.query(sql, [draft.id])).rejects.toMatchObject({ code: "P0001" });
  }
  await expect(withScope(finance, org, entity, "rules.read", c => c.query("TRUNCATE rule_versions"))).rejects.toMatchObject({ code: "42501" });
});
it("validates typed JSON and demo restrictions at the SQL boundary, not just HTTP", async () => {
  const raw = (definition: unknown, company = entity, actor = finance) => withScope(finance, org, company, "rules.create", c => c.query("INSERT INTO rule_versions(id,organization_id,legal_entity_id,definition,created_by) VALUES($1,$2,$3,$4,$5)", [randomUUID(), org, company, JSON.stringify(definition), actor]));
  for (const definition of [{ ...input(), definition: { formula: "select 1" } }, { ...input(), demoOnly: "true" }, { ...input(), applicability: { event: "bill", taxCode: "DEMO_OUTPUT" } }, { ...input(), sourceReferences: [] }, { ...input(), definition: { ...input().definition, rate: "101" } }, { ...input(), sourceReferences: [{ ...input().sourceReferences[0], url: "https://user:password@example.invalid" }] }]) await expect(raw(definition)).rejects.toMatchObject({ code: "P0001" });
  await expect(raw(input(), live)).rejects.toMatchObject({ code: "P0001" });
  await expect(raw(input(), entity, reviewer)).rejects.toMatchObject({ code: "P0001" });
});
it("stamps actor/time/hash, rejects client activation and supports bounded pages", async () => {
  const draft = await withScope(finance, org, entity, "rules.create", async c => (await c.query("INSERT INTO rule_versions(id,organization_id,legal_entity_id,definition,created_by,created_at,content_hash) VALUES($1,$2,$3,$4,$5,'1900-01-01','forged') RETURNING *", [randomUUID(), org, entity, JSON.stringify(input()), finance])).rows[0]);
  expect(new Date(draft.created_at).getFullYear()).toBeGreaterThan(1900); expect(draft.content_hash).toMatch(/^[a-f0-9]{64}$/);
  await expect(withScope(finance, org, entity, "rules.create", c => c.query("INSERT INTO rule_versions(id,organization_id,legal_entity_id,definition,created_by,status) VALUES($1,$2,$3,$4,$5,'active')", [randomUUID(), org, entity, JSON.stringify(input()), finance]))).rejects.toMatchObject({ code: "23514" });
  const first = await listRuleDrafts(reader, org, entity, 1); expect(first.data).toHaveLength(1); expect(first.nextCursor).not.toBeNull();
  const second = await listRuleDrafts(reader, org, entity, 1, first.nextCursor!); expect(second.data[0].id).not.toBe(first.data[0].id);
  await expect(listRuleDrafts(reader, org, entity, 101)).rejects.toBeDefined();
});
it("revoked membership defeats reads, creation and old successful replay", async () => {
  const key = randomUUID(); await create(input(), entity, key);
  await admin.query("UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2", [org, finance]);
  try { await expect(create(input(), entity, key)).rejects.toMatchObject({ status: 404 }); await expect(listRuleDrafts(finance, org, entity, 25)).rejects.toMatchObject({ status: 404 }); }
  finally { await admin.query("UPDATE memberships SET active=true WHERE organization_id=$1 AND user_id=$2", [org, finance]); }
});
it("audit failure atomically rolls back the draft and durable receipt", async () => {
  const suffix = randomUUID().replaceAll("-", ""), functionName = `rule_audit_fail_${suffix}`, triggerName = `rule_audit_fail_${suffix}`, key = randomUUID();
  await admin.query(`CREATE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id='${org}'::uuid AND NEW.action='rule.create' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF; RETURN NEW; END $$`);
  await admin.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION public.${functionName}()`);
  const before = Number((await admin.query("SELECT count(*) FROM rule_versions WHERE organization_id=$1", [org])).rows[0].count);
  try {
    await expect(create(input(), entity, key)).rejects.toMatchObject({ code: "P0001" });
    expect(Number((await admin.query("SELECT count(*) FROM rule_versions WHERE organization_id=$1", [org])).rows[0].count)).toBe(before);
    expect((await admin.query("SELECT key FROM idempotency_results WHERE organization_id=$1 AND key=$2", [org, key])).rowCount).toBe(0);
  } finally { await admin.query(`DROP TRIGGER ${triggerName} ON audit_events`); await admin.query(`DROP FUNCTION public.${functionName}()`); }
  expect(await create(input(), entity, key)).toMatchObject({ status: "draft" });
});
it("real scoped drafts and empty/expired selections never become posting authority", async () => {
  await create();
  const query = { kind: "sales_tax" as const, event: "invoice" as const, taxCode: "DEMO_OUTPUT", businessDate: "2026-10-13" };
  for (const input of [query, { ...query, businessDate: "2027-01-01" }, { ...query, taxCode: "MISSING" }]) await expect(checkTaxRuleAvailability(finance, org, entity, input)).rejects.toMatchObject({ code: "RULE_NOT_VERIFIED" });
  await create({ ...input(), demoOnly: false }, live);
  await expect(checkTaxRuleAvailability(finance, org, live, query)).rejects.toMatchObject({ code: "RULE_NOT_VERIFIED" });
  expect((await admin.query("SELECT count(*)::int AS n FROM rule_versions WHERE organization_id=$1 AND status<>'draft'", [org])).rows[0].n).toBe(0);
});
it("availability uses current membership and rejects client profile/reviewer overrides", async () => {
  const query = { kind: "sales_tax" as const, event: "invoice" as const, taxCode: "DEMO_OUTPUT", businessDate: "2026-10-13" };
  for (const user of [owner, administrator]) await expect(checkTaxRuleAvailability(user, org, entity, query)).rejects.toMatchObject({ status: 403 });
  await expect(checkTaxRuleAvailability(outsider, org, entity, query)).rejects.toMatchObject({ status: 404 });
  await expect(checkTaxRuleAvailability(finance, org, entity, { ...query, companyDemo: true } as typeof query)).rejects.toBeDefined();
  await admin.query("UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2", [org, reviewer]);
  try { await expect(checkTaxRuleAvailability(reviewer, org, entity, query)).rejects.toMatchObject({ status: 404 }); }
  finally { await admin.query("UPDATE memberships SET active=true WHERE organization_id=$1 AND user_id=$2", [org, reviewer]); }
});
it("persists scoped pending evidence without inventing capture, uploader or clean scan", async () => {
  const rule = await create(), grant = await upload(rule.id), document = await getPendingDocument(reviewer, org, entity, grant.documentId);
  expect(document).toEqual(grant.document); expect(document).toMatchObject({ ownerId: rule.id, status: "pending_upload", scanState: "quarantined", actualHash: null, capturedAt: null, uploadedBy: null, requestedBy: finance, demoOnly: true });
  const url = new URL(grant.url); expect(url.pathname).toContain(`/quarantine/${org}/${entity}/${grant.documentId}`); expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
  for (const header of ["content-length", "content-type", "if-none-match", "x-amz-checksum-sha256"]) expect(url.searchParams.get("X-Amz-SignedHeaders")!.split(";")).toContain(header);
  expect((await admin.query("SELECT count(*)::int AS n FROM audit_events WHERE target_id=$1 AND action='document.upload-request'", [document.id])).rows[0].n).toBe(1);
});
it("serializes upload replay, preserves the original grant/expiry and binds the body", async () => {
  const rule = await create(), key = randomUUID(), [a, b] = await Promise.all([upload(rule.id, key), upload(rule.id, key)]);
  expect(a).toEqual(b); expect(await upload(rule.id, key)).toEqual(a);
  await expect(requestRuleEvidenceUpload(finance, org, entity, { ...uploadInput(rule.id), filename: "Other.pdf" }, key, randomUUID())).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect((await admin.query("SELECT count(*)::int AS n FROM rule_evidence_requests WHERE id=$1", [a.documentId])).rows[0].n).toBe(1);
});
it("checks owner scope, current permissions and revocation before read or replay", async () => {
  const rule = await create(), key = randomUUID(), grant = await upload(rule.id, key), otherRule = await create(input(), other);
  await expect(upload(otherRule.id)).rejects.toMatchObject({ status: 404 });
  await expect(getPendingDocument(reader, org, other, grant.documentId)).rejects.toMatchObject({ status: 404 });
  for (const user of [reader, reviewer, administrator, owner]) await expect(requestRuleEvidenceUpload(user, org, entity, uploadInput(rule.id), randomUUID(), randomUUID())).rejects.toMatchObject({ status: 403 });
  await expect(getPendingDocument(outsider, org, entity, grant.documentId)).rejects.toMatchObject({ status: 404 });
  await admin.query("UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2", [org, finance]);
  try { await expect(upload(rule.id, key)).rejects.toMatchObject({ status: 404 }); }
  finally { await admin.query("UPDATE memberships SET active=true WHERE organization_id=$1 AND user_id=$2", [org, finance]); }
});
it("rejects undeclared or ambiguous source hashes before creating an upload request", async () => {
  const rule = await create();
  await expect(requestRuleEvidenceUpload(finance, org, entity, { ...uploadInput(rule.id), sha256: "c".repeat(64) }, randomUUID(), randomUUID())).rejects.toMatchObject({ code: "SOURCE_MISMATCH" });
  const command = input(); command.sourceReferences.push({ ...command.sourceReferences[0], title: "Other source", url: "https://example.invalid/other", section: "Other" });
  await expect(upload((await create(command)).id)).rejects.toMatchObject({ code: "SOURCE_MISMATCH" });
});
it("retains immutable SQL-owned source/profile/time and denies direct mutation", async () => {
  const rule = await create(), grant = await upload(rule.id);
  for (const statement of ["UPDATE rule_evidence_requests SET scan_state='clean' WHERE id=$1", "DELETE FROM rule_evidence_requests WHERE id=$1"]) await expect(withScope(finance, org, entity, "documents.create", client => client.query(statement, [grant.documentId]))).rejects.toBeDefined();
  await expect(admin.query("UPDATE rule_evidence_requests SET demo_only=false WHERE id=$1", [grant.documentId])).rejects.toThrow("append-only");
  const insert = (patch: object, actor = finance) => withScope(finance, org, entity, "documents.create", client => client.query("INSERT INTO rule_evidence_requests(id,organization_id,legal_entity_id,rule_id,declaration,source_references,demo_only,created_by,created_at) VALUES($1,$2,$3,$4,$5,'[]',false,$6,'1900-01-01') RETURNING *", [randomUUID(), org, entity, rule.id, JSON.stringify({ filename: "source.pdf", contentType: "application/pdf", sizeBytes: 100, sha256: "b".repeat(64), ...patch }), actor]));
  for (const patch of [{ sizeBytes: 10485761 }, { sizeBytes: -1 }, { sizeBytes: 1.5 }, { filename: "../source.pdf" }, { contentType: "text/html" }, { scanState: "clean" }, { sha256: "c".repeat(64) }]) await expect(insert(patch)).rejects.toBeDefined();
  await expect(insert({}, reader)).rejects.toBeDefined();
  const row = (await insert({})).rows[0]; expect(row.demo_only).toBe(true); expect(row.source_references).toEqual(rule.sourceReferences); expect(row.created_at.getUTCFullYear()).not.toBe(1900);
});
it("missing private-storage configuration creates no reservation or receipt", async () => {
  const rule = await create(), key = randomUUID(), endpoint = process.env.S3_ENDPOINT; delete process.env.S3_ENDPOINT;
  try { await expect(upload(rule.id, key)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" }); }
  finally { process.env.S3_ENDPOINT = endpoint; }
  expect((await admin.query("SELECT id FROM rule_evidence_requests WHERE rule_id=$1", [rule.id])).rowCount).toBe(0);
  expect((await admin.query("SELECT key FROM idempotency_results WHERE organization_id=$1 AND key=$2", [org, key])).rowCount).toBe(0);
});
it("audit failure rolls back a signed upload reservation and its durable receipt", async () => {
  const rule = await create(), key = randomUUID(), suffix = randomUUID().replaceAll("-", ""), name = `rule_audit_fail_${suffix}`;
  await admin.query(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id='${org}'::uuid AND NEW.action='document.upload-request' THEN RAISE EXCEPTION 'Synthetic upload audit failure'; END IF; RETURN NEW; END $$`);
  await admin.query(`CREATE TRIGGER ${name} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION public.${name}()`);
  try {
    await expect(upload(rule.id, key)).rejects.toMatchObject({ code: "P0001" });
    expect((await admin.query("SELECT id FROM rule_evidence_requests WHERE rule_id=$1", [rule.id])).rowCount).toBe(0);
    expect((await admin.query("SELECT key FROM idempotency_results WHERE organization_id=$1 AND key=$2", [org, key])).rowCount).toBe(0);
  } finally { await admin.query(`DROP TRIGGER ${name} ON audit_events`); await admin.query(`DROP FUNCTION public.${name}()`); }
  expect((await upload(rule.id, key)).document.status).toBe("pending_upload");
});
