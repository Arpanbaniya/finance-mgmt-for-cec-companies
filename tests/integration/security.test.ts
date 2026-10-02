import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, expect, it } from "vitest";
import { databasePool } from "@/db/client";
import { listEntities, getEntity, createEntity, patchEntity } from "@/features/platform/service";
import { changeMember, listMembers } from "@/features/platform/memberships";
import { sessionMemberships } from "@/features/identity/session";
import { withScope } from "@/features/identity/scope";
import { EntityCreate } from "@/features/platform/contracts";
config({ path: ".env.local", quiet: true });

const orgA = randomUUID(), orgB = randomUUID(), entityA = randomUUID(), entityB = randomUUID(), maker = `test-${randomUUID()}`, second = `test-${randomUUID()}`, outsider = `test-${randomUUID()}`;
const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
beforeAll(async () => {
  const url = new URL(process.env.MIGRATION_DATABASE_URL ?? "");
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/kaamledger") throw new Error("Security tests require the dedicated local database.");
  for (const id of [maker, second, outsider]) await admin.query("INSERT INTO auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Test identity',$2,true,now(),now())", [id, `${id}@example.invalid`]);
  await admin.query("INSERT INTO organizations(id,name) VALUES($1,'Organization A'),($2,'Organization B')", [orgA, orgB]);
  await admin.query("INSERT INTO legal_entities(id,organization_id,name,active_modes,reporting_profile,created_by) VALUES($1,$2,'Company A','[\"labour\"]','demo_accrual',$3),($4,$5,'Company B','[\"labour\"]','demo_accrual',$6)", [entityA, orgA, maker, entityB, orgB, outsider]);
  for (const [user, org, entity] of [[maker, orgA, entityA], [second, orgA, entityA], [outsider, orgB, entityB]]) await admin.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids,active) VALUES($1,$2,$3,'[\"organization_admin\"]',$4,'[]',true)", [randomUUID(), org, user, JSON.stringify([entity])]);
});
afterAll(async () => {
  // Remove only this run's generated test fixtures, using the migration principal.
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE audit_events DISABLE TRIGGER audit_append_only");
    await client.query("DELETE FROM audit_events WHERE organization_id=ANY($1::uuid[])", [[orgA, orgB]]);
    await client.query("DELETE FROM idempotency_results WHERE organization_id=ANY($1::uuid[])", [[orgA, orgB]]);
    await client.query("DELETE FROM branches WHERE organization_id=ANY($1::uuid[])", [[orgA, orgB]]);
    await client.query("DELETE FROM memberships WHERE organization_id=ANY($1::uuid[])", [[orgA, orgB]]);
    await client.query("DELETE FROM legal_entities WHERE organization_id=ANY($1::uuid[])", [[orgA, orgB]]);
    await client.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [[orgA, orgB]]);
    await client.query("DELETE FROM auth_user WHERE id=ANY($1::text[])", [[maker, second, outsider]]);
    await client.query("ALTER TABLE audit_events ENABLE TRIGGER audit_append_only");
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); await admin.end(); await databasePool().end(); }
});
it("runtime role is nonowner, nonsuperuser, without RLS bypass", async () => {
  const result = await databasePool().query("SELECT r.rolsuper,r.rolbypassrls,r.rolcreaterole,(c.relowner=r.oid) AS owns_table FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user AND c.relname='legal_entities'");
  expect(result.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, owns_table: false });
});
it("unscoped runtime SQL sees no legal entities", async () => { expect((await databasePool().query("SELECT * FROM legal_entities")).rows).toHaveLength(0); });
it("organization and entity isolation holds through API services", async () => {
  expect((await listEntities(maker, orgA, 25)).data.map(e => e.id)).toEqual([entityA]);
  await expect(getEntity(maker, orgB, entityB)).rejects.toMatchObject({ status: 404 });
  await expect(getEntity(maker, orgA, entityB)).rejects.toMatchObject({ status: 404 });
});
it("direct scoped SQL cannot read another entity even with guessed organization scope", async () => {
  const rows = await withScope(maker, orgA, entityA, "entity.read", async client => (await client.query("SELECT * FROM legal_entities WHERE id=$1", [entityB])).rows);
  expect(rows).toHaveLength(0);
});
it("composite FKs reject a branch linked across organizations", async () => {
  await expect(admin.query("INSERT INTO branches(id,organization_id,legal_entity_id,name) VALUES($1,$2,$3,'Invalid')", [randomUUID(), orgA, entityB])).rejects.toMatchObject({ code: "23503" });
});
it("pooled transaction scope does not leak between requests", async () => {
  await getEntity(maker, orgA, entityA);
  expect((await databasePool().query("SELECT * FROM legal_entities")).rows).toHaveLength(0);
  expect((await listEntities(outsider, orgB, 25)).data.map(e => e.id)).toEqual([entityB]);
});
it("concurrent create retry yields one entity, audit, and durable response", async () => {
  const input = EntityCreate.parse({ name: "Concurrent company", baseCurrency: "NPR", timezone: "Asia/Kathmandu", activeModes: ["labour"], reportingProfile: "demo_accrual" });
  const key = randomUUID();
  const [a, b] = await Promise.all([createEntity(maker, orgA, input, key, randomUUID()), createEntity(maker, orgA, input, key, randomUUID())]);
  expect(a).toEqual(b);
  expect((await admin.query("SELECT * FROM audit_events WHERE target_id=$1", [a.id])).rowCount).toBe(1);
  await expect(createEntity(maker, orgA, { ...input, name: "Other" }, key, randomUUID())).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await patchEntity(maker, orgA, a.id, { name: "Changed after creation" }, 1, randomUUID());
  expect(await createEntity(maker, orgA, input, key, randomUUID())).toEqual(a);
});
it("stale If-Match changes nothing", async () => {
  const updated = await patchEntity(maker, orgA, entityA, { name: "Updated company" }, 1, randomUUID());
  expect(updated.version).toBe(2);
  await expect(patchEntity(maker, orgA, entityA, { name: "Stale overwrite" }, 1, randomUUID())).rejects.toMatchObject({ status: 412 });
});
it("nullable identifiers clear explicitly; omitted identifiers remain unchanged", async () => {
  const current = await getEntity(maker, orgA, entityA);
  const identified = await patchEntity(maker, orgA, entityA, { registrationIdentifier: "REG-TEST", taxIdentifier: "TAX-TEST" }, current.version, randomUUID());
  const renamed = await patchEntity(maker, orgA, entityA, { name: "Renamed with identifiers" }, identified.version, randomUUID());
  expect(renamed.registrationIdentifier).toBe("REG-TEST"); expect(renamed.taxIdentifier).toBe("TAX-TEST");
  const cleared = await patchEntity(maker, orgA, entityA, { registrationIdentifier: null, taxIdentifier: null }, renamed.version, randomUUID());
  expect(cleared.registrationIdentifier).toBeNull(); expect(cleared.taxIdentifier).toBeNull();
});
it("administrators cannot alter their own roles", async () => {
  await expect(changeMember(maker, orgA, { userId: maker, roleIds: ["finance_manager"], allowedEntityIds: [entityA], siteIds: [], active: true }, randomUUID(), { key: randomUUID() })).rejects.toMatchObject({ code: "SELF_ESCALATION" });
});
it("membership creation replay is atomic and stale changes preserve grants", async () => {
  const input = { userId: outsider, roleIds: ["accountant" as const], allowedEntityIds: [entityA], siteIds: [], active: true }, key = randomUUID();
  const [a, b] = await Promise.all([changeMember(maker, orgA, input, randomUUID(), { key }), changeMember(maker, orgA, input, randomUUID(), { key })]);
  expect(a).toEqual(b);
  expect((await admin.query("SELECT * FROM audit_events WHERE target_id=$1", [a.id])).rowCount).toBe(1);
  await expect(changeMember(maker, orgA, { ...input, active: false }, randomUUID(), { key })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  const updated = await changeMember(maker, orgA, { ...input, roleIds: ["auditor"] }, randomUUID(), { id: a.id, version: 1 });
  expect(updated.version).toBe(2);
  await expect(changeMember(maker, orgA, { ...input, active: false }, randomUUID(), { id: a.id, version: 1 })).rejects.toMatchObject({ status: 412 });
  expect((await listMembers(maker, orgA, 100)).data.find(m => m.id === a.id)).toEqual(updated);
  expect(await changeMember(maker, orgA, input, randomUUID(), { key })).toEqual(a);
  await expect(listMembers(outsider, orgA, 25)).rejects.toMatchObject({ status: 403 });
});
it("unknown identities, immutable users, and cross-organization memberships are rejected", async () => {
  const input = { userId: outsider, roleIds: ["accountant" as const], allowedEntityIds: [], siteIds: [], active: true };
  await expect(changeMember(maker, orgA, { ...input, userId: "not-provisioned" }, randomUUID(), { key: randomUUID() })).rejects.toMatchObject({ code: "INVALID_IDENTITY" });
  const member = (await listMembers(maker, orgA, 100)).data.find(m => m.userId === outsider)!;
  await expect(changeMember(maker, orgA, { ...input, userId: second }, randomUUID(), { id: member.id, version: member.version })).rejects.toMatchObject({ code: "IMMUTABLE_IDENTITY" });
  await expect(changeMember(maker, orgB, input, randomUUID(), { id: member.id, version: member.version })).rejects.toMatchObject({ status: 404 });
});
it("revoked membership disappears on the next authorized request", async () => {
  expect(await sessionMemberships(second)).toHaveLength(1);
  await admin.query("UPDATE memberships SET active=false WHERE user_id=$1", [second]);
  await expect(listEntities(second, orgA, 25)).rejects.toMatchObject({ status: 404 });
  expect(await sessionMemberships(second)).toHaveLength(0);
});
it("last administrator and cross-organization grants are blocked by SQL guards", async () => {
  await expect(admin.query("UPDATE memberships SET active=false WHERE user_id=$1", [maker])).rejects.toThrow("last administrator");
  await expect(admin.query("UPDATE memberships SET allowed_entity_ids=$1 WHERE user_id=$2", [JSON.stringify([entityB]), maker])).rejects.toThrow("another organization");
});
it("runtime cannot mutate audit history or disable RLS", async () => {
  await expect(databasePool().query("DELETE FROM audit_events")).rejects.toMatchObject({ code: "42501" });
  await expect(databasePool().query("ALTER TABLE legal_entities DISABLE ROW LEVEL SECURITY")).rejects.toMatchObject({ code: "42501" });
});
