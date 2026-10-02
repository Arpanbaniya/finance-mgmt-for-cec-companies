import { expect, it } from "vitest";
import { EntityCreate, EntityPatch, MembershipChange, ListQuery } from "@/features/platform/contracts";
import { parity } from "@/scripts/route-parity";
const valid = { name: "Example Pvt. Ltd.", baseCurrency: "NPR", timezone: "Asia/Kathmandu", activeModes: ["labour"], reportingProfile: "demo_accrual" };
it("rejects client scope, computed totals and future modules", () => {
  expect(EntityCreate.safeParse({ ...valid, organizationId: "injected" }).success).toBe(false);
  expect(EntityCreate.safeParse({ ...valid, baseCurrency: "USD" }).success).toBe(false);
  expect(EntityCreate.safeParse({ ...valid, activeModes: ["construction"] }).success).toBe(false);
});
it("PATCH excludes identity and requires an actual edit", () => { expect(EntityPatch.safeParse({}).success).toBe(false); expect(EntityPatch.safeParse({ id: "changed" }).success).toBe(false); expect(EntityPatch.safeParse({ name: "New" }).success).toBe(true); });
it("limits pagination and denies arbitrary query fields", () => { expect(ListQuery.safeParse({ limit: "101" }).success).toBe(false); expect(ListQuery.safeParse({ sort: "sql" }).success).toBe(false); });
it("uses a finite role registry and does not allow future site grants", () => { expect(MembershipChange.safeParse({ userId: "a", roleIds: ["super_admin"], allowedEntityIds: [], siteIds: [], active: true }).success).toBe(false); });
it("all shipped operations match the 256-operation planned catalog", () => { expect(parity()).toEqual({ planned: 256, implemented: 16, remaining: 240 }); });
