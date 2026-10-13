import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { DocumentUploadRequest } from "@/features/documents/contracts";
import { permissionsFor } from "@/domain/permissions";
import { openapi } from "@/features/platform/openapi";
const request = { filename: "source.pdf", contentType: "application/pdf", sizeBytes: 100, sha256: "b".repeat(64), sensitivity: "internal", ownerType: "rule_version", ownerId: randomUUID() };
it("requires a strict supported rule-owned declaration, never scan/capture/scope overrides", () => {
  expect(DocumentUploadRequest.safeParse(request).success).toBe(true);
  for (const patch of [{ scanState: "clean" }, { actualHash: "b".repeat(64) }, { uploadedBy: "forged" }, { organizationId: randomUUID() }, { demoOnly: false }, { ownerType: "worker" }, { sensitivity: "restricted" }, { sizeBytes: 10485761 }, { filename: "file.svg" }]) expect(DocumentUploadRequest.safeParse({ ...request, ...patch }).success).toBe(false);
});
it("exports two finite pending-upload operations, not completion or release", () => {
  const spec = openapi(), root = "/api/v1/orgs/{orgId}/entities/{entityId}/documents";
  expect(spec.paths[`${root}/upload-requests`]).toHaveProperty("post.requestBody.content.application/json.schema.$ref", "#/components/schemas/DocumentUploadRequest");
  expect(spec.paths[`${root}/{id}`]).toHaveProperty("get"); expect(spec.paths).not.toHaveProperty(`${root}/{id}/complete`); expect(spec.paths).not.toHaveProperty(`${root}/{id}/download-link`);
  expect(spec.components.schemas.Document).toHaveProperty("properties.data.properties.scanState.const", "quarantined");
  expect(spec.components.schemas.Document).toHaveProperty("properties.data.properties.actualHash.type", "null");
  expect(spec.components.schemas.DocumentUploadRequest).toHaveProperty("additionalProperties", false);
});
it("grants only current rule-reader metadata and finance upload requests", () => {
  for (const role of ["finance_manager", "accountant", "auditor", "policy_reviewer"]) expect(permissionsFor([role]).has("documents.read")).toBe(true);
  for (const role of ["organization_admin", "owner", "site_supervisor"]) expect(permissionsFor([role]).has("documents.read")).toBe(false);
  expect(permissionsFor(["finance_manager"]).has("documents.create")).toBe(true);
  for (const role of ["accountant", "auditor", "policy_reviewer"]) expect(permissionsFor([role]).has("documents.create")).toBe(false);
  expect(permissionsFor(["finance_manager"]).has("documents.update")).toBe(false);
});
