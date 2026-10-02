import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { AccountCreate, AccountPatch } from "@/domain/accounts";
import { openapi } from "@/features/platform/openapi";
const ordinary = { code: " exp-01 ", name: " Expense account ", type: "expense", normalSide: "debit", isControl: false, reportMapping: { statementSection: "expenses", cashFlowCategory: "unclassified" } };
it("account creation canonicalizes codes, requires finite classifications and rejects computed/scope fields", () => {
  expect(AccountCreate.parse(ordinary)).toMatchObject({ code: "EXP-01", name: "Expense account", parentId: null, controlType: null });
  for (const input of [{ ...ordinary, organizationId: randomUUID() }, { ...ordinary, balance: "0.00" }, { ...ordinary, type: "inventory" }, { ...ordinary, active: false }, { ...ordinary, version: 10 }, { ...ordinary, createdBy: "other" }, { ...ordinary, code: "bad code" }]) expect(AccountCreate.safeParse(input).success).toBe(false);
});
it("control role and report mapping agree with the immutable account classification", () => {
  for (const input of [{ ...ordinary, isControl: true }, { ...ordinary, controlType: "ar" }, { ...ordinary, isControl: true, controlType: "ar" }, { ...ordinary, reportMapping: { statementSection: "assets", cashFlowCategory: "unclassified" } }, { ...ordinary, reportMapping: { statementSection: "expenses", cashFlowCategory: "cash" } }]) expect(AccountCreate.safeParse(input).success).toBe(false);
  expect(AccountCreate.safeParse({ ...ordinary, type: "asset", normalSide: "credit", isControl: true, controlType: "cash", reportMapping: { statementSection: "assets", cashFlowCategory: "cash" } }).success).toBe(true);
});
it("account patch is the exact permitted subset with nullable parent clearing", () => {
  expect(AccountPatch.parse({ parentId: null })).toEqual({ parentId: null });
  for (const input of [{}, { code: "changed" }, { type: "asset" }, { normalSide: "credit" }, { active: false }, { controlType: "cash" }, { isControl: true }, { name: null }, { reportMapping: { statementSection: "expenses", cashFlowCategory: "expression" } }]) expect(AccountPatch.safeParse(input).success).toBe(false);
});
it("five catalog account operations have specific schemas and correct create/update/archive headers", () => {
  const doc = openapi(), base = "/api/v1/orgs/{orgId}/entities/{entityId}/accounts";
  expect(doc.components.schemas.Account).toBeDefined(); expect(doc.components.schemas.AccountList).toBeDefined();
  expect(doc.components.schemas.AccountCreate).toMatchObject({ properties: { code: { type: "string", maxLength: 100, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" } } });
  const create = doc.paths[base].post as { responses: Record<string, { headers: Record<string, unknown> }> };
  expect(create.responses["201"].headers.Location).toBeDefined(); expect(create.responses["201"].headers.ETag).toBeDefined();
  const archive = doc.paths[`${base}/{id}/archive`].post as { responses: Record<string, { headers: Record<string, unknown> }>; parameters: { name: string; required?: boolean }[] };
  expect(archive.responses["200"].headers.ETag).toBeDefined(); expect(archive.responses["201"]).toBeUndefined();
  expect(archive.parameters.filter(p => ["If-Match", "Idempotency-Key"].includes(p.name)).every(p => p.required)).toBe(true);
});
