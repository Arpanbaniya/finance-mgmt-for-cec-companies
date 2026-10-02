import { expect, it } from "vitest";
import { permissionsFor } from "@/domain/permissions";
it("organization administration does not grant finance approval", () => { expect(permissionsFor(["organization_admin"]).has("journals.approve")).toBe(false); });
it("unknown roles deny all permissions", () => { expect(permissionsFor(["super_admin"]).size).toBe(0); });
it("site supervisors cannot access payroll or posting", () => { const p = permissionsFor(["site_supervisor"]); expect(p.has("payroll.read")).toBe(false); expect(p.has("journals.post")).toBe(false); });
