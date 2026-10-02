import { expect, it } from "vitest";
import { ApprovalPolicyCreate, AuditQuery, Transition } from "@/features/approvals/contracts";
import { openapi } from "@/features/platform/openapi";
const valid = { name: "Review", effectiveFrom: "2026-01-01", aggregateTypes: ["journal"], currency: "NPR", makerChecker: true, thresholds: [{ minInclusive: "0.00", requiredPermission: "journals.approve", numberOfDistinctApprovers: 1 }] };
it("policies forbid bypasses, unknown scope, numbers, incomplete ranges and wrong permissions", () => {
  for (const bad of [{ ...valid, makerChecker: false }, { ...valid, organizationId: "injected" }, { ...valid, effectiveFrom: "2026-02-30" }, { ...valid, effectiveTo: "2026-01-01" }, { ...valid, aggregateTypes: ["journal", "journal"] }, { ...valid, aggregateTypes: ["journal", "invoice"] },
    { ...valid, thresholds: [{ minInclusive: 0, requiredPermission: "journals.approve", numberOfDistinctApprovers: 1 }] },
    { ...valid, thresholds: [{ ...valid.thresholds[0], minInclusive: "1.00" }] }, { ...valid, thresholds: [{ ...valid.thresholds[0], maxExclusive: "100.00" }] },
    { ...valid, thresholds: [{ ...valid.thresholds[0], requiredPermission: "invoices.approve" }] }, { ...valid, thresholds: [{ ...valid.thresholds[0], numberOfDistinctApprovers: 0 }] }]) expect(ApprovalPolicyCreate.safeParse(bad).success).toBe(false);
  expect(ApprovalPolicyCreate.safeParse(valid).success).toBe(true);
  expect(ApprovalPolicyCreate.safeParse({ ...valid, thresholds: [{ ...valid.thresholds[0], maxExclusive: "100.00" }, { ...valid.thresholds[0], minInclusive: "99.99" }] }).success).toBe(false);
  expect(Transition.safeParse({ version: 2 }).success).toBe(false);
});
it("audit filters are bounded, strict, metadata-only and half-open", () => {
  expect(AuditQuery.safeParse({ includePrivateValues: true }).success).toBe(false);
  expect(AuditQuery.safeParse({ limit: 101 }).success).toBe(false);
  expect(AuditQuery.safeParse({ fromInstant: "2026-10-02T00:00:00Z", toInstantExclusive: "2026-10-01T00:00:00Z" }).success).toBe(false);
  expect(AuditQuery.parse({ action: "approval_policy.create", limit: "1" }).limit).toBe(1);
});
it("every exposed schema ref resolves, activation is 200 and headers are documented", () => {
  const document = openapi(), json = JSON.stringify(document);
  for (const reference of json.matchAll(/#\/components\/schemas\/([^"\\]+)/g)) expect(Object.hasOwn(document.components.schemas, reference[1])).toBe(true);
  const paths = document.paths as Record<string, Record<string, { responses: Record<string, { headers: Record<string, unknown> }> }>>;
  const base = "/api/v1/orgs/{orgId}/entities/{entityId}/approval-policies";
  expect(paths[`${base}/{id}/activate`].post.responses["200"].headers.ETag).toBeDefined();
  expect(paths[base].post.responses["201"].headers.Location).toBeDefined();
});
