import { expect, it } from "vitest";
import { permissionsFor } from "@/domain/permissions";
it("organization administration does not grant finance approval", () => { expect(permissionsFor(["organization_admin"]).has("journals.approve")).toBe(false); });
it("unknown roles deny all permissions", () => { expect(permissionsFor(["super_admin"]).size).toBe(0); });
it("inherited object names are not roles", () => { expect(permissionsFor(["__proto__", "constructor", "toString"]).size).toBe(0); });
it("policy activation is a separate explicitly delegated grant", () => { expect(permissionsFor(["finance_manager"]).has("approval_policies.activate")).toBe(false); expect(permissionsFor(["organization_admin"]).has("approval_policies.activate")).toBe(false); expect(permissionsFor(["policy_reviewer"]).has("approval_policies.activate")).toBe(true); expect(permissionsFor(["policy_reviewer"]).has("journals.approve")).toBe(false); });
it("site supervisors cannot access payroll or posting", () => { const p = permissionsFor(["site_supervisor"]); expect(p.has("payroll.read")).toBe(false); expect(p.has("journals.post")).toBe(false); });
