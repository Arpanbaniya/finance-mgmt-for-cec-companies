import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PartyCreate, PartyPatch, PartyDTO } from "@/features/parties/contracts";
import { permissionsFor } from "@/domain/permissions";
import { openapi } from "@/features/platform/openapi";
const input = { name: "  Example   company  ", roleSet: ["supplier", "customer"], creditLimit: "999999999999999999.99" };
it("normalizes one identity with both roles, default terms and exact money", () => {
  expect(PartyCreate.parse(input)).toMatchObject({ name: "Example company", roleSet: ["customer", "supplier"], creditLimit: "999999999999999999.99", active: true, paymentTermsDays: 0, contact: null });
  expect(PartyCreate.parse({ ...input, creditLimit: "0" }).creditLimit).toBe("0.00");
});
it.each([[], ["customer", "customer"], ["owner"], ["customer", "supplier", "customer"]].map(roleSet => ({ roleSet })))("rejects invalid role sets $roleSet", ({ roleSet }) => {
  expect(PartyCreate.safeParse({ ...input, roleSet }).success).toBe(false);
});
it.each([1, "-1", "01.00", "1e2", "1.001", "1000000000000000000", "NaN", "Infinity"])("rejects invalid credit limit %j", creditLimit => {
  expect(PartyCreate.safeParse({ ...input, creditLimit }).success).toBe(false);
});
it("rejects supplier credit, invalid terms, private banking fields and injected scope", () => {
  expect(PartyCreate.safeParse({ ...input, roleSet: ["supplier"] }).success).toBe(false);
  for (const paymentTermsDays of [-1, 1.5, "30", 3651]) expect(PartyCreate.safeParse({ ...input, paymentTermsDays }).success).toBe(false);
  for (const field of ["organizationId", "entityId", "id", "bankDetails", "version", "createdBy", "archivedAt"]) expect(PartyCreate.safeParse({ ...input, [field]: randomUUID() }).success).toBe(false);
  expect(PartyCreate.safeParse({ ...input, active: false }).success).toBe(false);
});
it("PATCH requires explicit mutable fields and distinguishes clearing from omission", () => {
  expect(PartyPatch.parse({ contact: null })).toEqual({ contact: null }); expect(PartyPatch.parse({ name: " New " })).toEqual({ name: "New" });
  for (const patch of [{}, { active: false }, { creditLimit: 20 }, { id: randomUUID() }, { name: null }, { roleSet: [] }, { contact: "" }]) expect(PartyPatch.safeParse(patch).success).toBe(false);
});
it("finite finance grants do not expose party identities to owner or administrator", () => {
  expect(permissionsFor(["finance_manager"]).has("parties.update")).toBe(true);
  for (const role of ["accountant", "auditor"]) { expect(permissionsFor([role]).has("parties.read")).toBe(true); expect(permissionsFor([role]).has("parties.create")).toBe(false); }
  for (const role of ["owner", "organization_admin", "site_supervisor", "policy_reviewer"]) expect(permissionsFor([role]).has("parties.read")).toBe(false);
});
it("documents concrete party resources, list and conditional mutation headers", () => {
  const spec = openapi(), base = "/api/v1/orgs/{orgId}/entities/{entityId}/parties";
  expect(spec.paths[base].post).toMatchObject({ "x-permission": "parties.create", requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/PartyCreate" } } } } });
  expect(JSON.stringify(spec.paths[`${base}/{id}`].patch)).toContain("If-Match");
  expect(JSON.stringify(spec.paths[`${base}/{id}/archive`].post)).toContain("Idempotency-Key");
  expect(JSON.stringify(spec.components.schemas.PartyCreate)).toContain("pattern");
  expect(spec.paths[`${base}/{id}/statement`]).toBeUndefined();
  expect(PartyDTO.shape.creditLimit.safeParse(1).success).toBe(false);
});
