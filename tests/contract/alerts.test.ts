import { expect, it } from "vitest";
import { Reason, AlertDTO, AlertCommandResult } from "@/features/alerts/contracts";
import { openapi } from "@/features/platform/openapi";
it("acknowledgement requires a reason and rejects protected or injected fields", () => {
  expect(Reason.parse({ reason: "  Reviewed notification  " })).toEqual({ reason: "Reviewed notification" });
  for (const bad of [{}, { reason: "ab" }, { reason: "Seen", recipientId: "other" }, { reason: "Seen", status: "acknowledged" }, { reason: "x".repeat(1001) }]) expect(Reason.safeParse(bad).success).toBe(false);
  expect(AlertDTO.safeParse({ policyId: "injected" }).success).toBe(false);
  expect(AlertCommandResult.shape.status.safeParse("active").success).toBe(false);
});
it("catalog alert operations expose concrete DTOs, query bounds and 200 ETag acknowledgement", () => {
  const document = openapi(), base = "/api/v1/orgs/{orgId}/entities/{entityId}/alerts";
  expect(document.components.schemas.AlertList).toBeDefined(); expect(document.components.schemas.Reason).toBeDefined();
  const operation = document.paths[`${base}/{id}/acknowledge`].post as { parameters: { name: string; required?: boolean }[]; responses: Record<string, { headers: Record<string, unknown> }> };
  expect(operation.responses["200"].headers.ETag).toBeDefined(); expect(operation.responses["201"]).toBeUndefined();
  expect(operation.parameters.filter(p => ["If-Match", "Idempotency-Key"].includes(p.name)).every(p => p.required)).toBe(true);
});
