export const roleGrants = {
  organization_admin: ["entity.read", "entity.create", "entity.update", "membership.read", "membership.create", "membership.update", "settings.read", "approvals.read", "approvals.create", "audit.read"],
  owner: ["entity.read", "reports.read", "dashboard.owner"],
  finance_manager: ["entity.read", "accounts.read", "accounts.create", "accounts.update", "journals.read", "journals.create", "journals.update", "journals.submit", "journals.approve", "journals.post", "journals.reverse", "periods.read", "periods.create", "periods.close", "periods.reopen", "periods.approve", "reports.read", "audit.read", "approvals.read", "approvals.create"],
  accountant: ["entity.read", "accounts.read", "journals.read", "journals.create", "journals.update", "journals.submit", "periods.read", "reports.read"],
  auditor: ["entity.read", "accounts.read", "journals.read", "periods.read", "reports.read", "audit.read", "approvals.read"],
  site_supervisor: ["entity.read", "sites.read", "workers.read", "attendance.read", "attendance.create", "attendance.submit", "expenses.create"],
  policy_reviewer: ["entity.read", "approvals.read", "approval_policies.activate"]
} as const;
export type Role = keyof typeof roleGrants;
export function permissionsFor(roles: string[]): Set<string> {
  return new Set(roles.flatMap(role => Object.hasOwn(roleGrants, role) ? [...roleGrants[role as Role]] : []));
}
