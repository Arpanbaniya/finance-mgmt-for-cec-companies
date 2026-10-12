import { expect, it } from "vitest";
import { openapi } from "@/features/platform/openapi";
import { permissionsFor } from "@/domain/permissions";
it("separates catalog draft input from immutable server-owned response", () => {
  const spec = openapi(), path = "/api/v1/orgs/{orgId}/entities/{entityId}/rule-versions";
  const post = spec.paths[path].post as { requestBody: { content: { "application/json": { schema: { $ref: string } } } }; responses: Record<string, unknown> };
  expect(post.requestBody.content["application/json"].schema.$ref).toBe("#/components/schemas/PolicyDraftInput");
  const input = spec.components.schemas.PolicyDraftInput as { properties: Record<string, unknown>; additionalProperties: boolean };
  expect(input.additionalProperties).toBe(false); expect(input.properties).not.toHaveProperty("status"); expect(input.properties).not.toHaveProperty("createdBy");
  expect(spec.components.schemas.PolicyDraft).toHaveProperty("properties.data.properties.status.const", "draft");
  expect(spec.paths).not.toHaveProperty(`${path}/{id}/activate`); expect(spec.paths).not.toHaveProperty(`${path}/{id}/verify`);
});
it("grants draft readers and a finance creator without enabling activation", () => {
  for (const role of ["finance_manager", "accountant", "auditor", "policy_reviewer"]) expect(permissionsFor([role]).has("rules.read")).toBe(true);
  for (const role of ["accountant", "auditor", "policy_reviewer", "owner", "organization_admin"]) expect(permissionsFor([role]).has("rules.create")).toBe(false);
  expect(permissionsFor(["finance_manager"]).has("rules.create")).toBe(true);
  for (const role of ["finance_manager", "policy_reviewer"]) expect(permissionsFor([role]).has("rules.activate")).toBe(false);
});
