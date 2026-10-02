import { expect, it } from "vitest";
import { JobDTO, JobResult, Reason } from "@/features/jobs/contracts";
import { openapi } from "@/features/platform/openapi";
import { permissionsFor } from "@/domain/permissions";
it("recovery accepts only a required reason, never client state or attempt counters", () => {
  for (const input of [{}, { reason: "ab" }, { reason: "Recovered", attempts: 0 }, { reason: "Recovered", status: "pending" }, { reason: "Recovered", principalId: "other" }]) expect(Reason.safeParse(input).success).toBe(false);
  expect(JobDTO.shape.status.safeParse("running").success).toBe(false);
  expect(JobResult.shape.status.safeParse("delivered").success).toBe(false);
  expect(JobDTO.shape.totalAttempts.safeParse(13).success).toBe(false);
});
it("ordinary finance/admin grants do not imply reviewer job authority", () => {
  expect(permissionsFor(["organization_admin", "finance_manager"]).has("jobs.update")).toBe(false);
  expect(permissionsFor(["policy_reviewer"]).has("jobs.read")).toBe(true);
});
it("catalog job operations expose real status and 202 Location/ETag recovery contracts", () => {
  const doc = openapi(), base = "/api/v1/orgs/{orgId}/entities/{entityId}/jobs/{id}";
  expect(doc.components.schemas.Job).toBeDefined(); expect(doc.components.schemas.JobResult).toBeDefined();
  const get = doc.paths[base].get as { responses: Record<string, { headers: Record<string, unknown> }> };
  expect(get.responses["200"].headers.ETag).toBeDefined();
  const retry = doc.paths[`${base}/retry`].post as { parameters: { name: string; required?: boolean }[]; responses: Record<string, { headers: Record<string, unknown> }> };
  expect(retry.responses["202"].headers.Location).toBeDefined(); expect(retry.responses["202"].headers.ETag).toBeDefined(); expect(retry.responses["201"]).toBeUndefined();
  expect(retry.parameters.filter(p => ["If-Match", "Idempotency-Key"].includes(p.name)).every(p => p.required)).toBe(true);
});
