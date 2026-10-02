import { headers } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { configured } from "@/db/client";
import { auth } from "@/features/identity/auth";
import { sessionMemberships } from "@/features/identity/session";
import { permissionsFor } from "@/domain/permissions";
import { localDate } from "@/domain/dates";
import { uuid } from "@/features/platform/contracts";
import { getEntity } from "@/features/platform/service";
import { AuditQuery } from "@/features/approvals/contracts";
import { listAudit, listPolicies } from "@/features/approvals/service";
import { ControlsWorkspace } from "@/features/approvals/controls-workspace";

export const dynamic = "force-dynamic";
export const metadata = { title: "Approval policies and audit" };
export default async function ControlsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!configured()) redirect("/sign-in");
  const identity = await auth().api.getSession({ headers: await headers() });
  if (!identity) redirect("/sign-in");
  const query = await searchParams, org = uuid.safeParse(query.org), entity = uuid.safeParse(query.entity);
  const cursor = query.policyCursor === undefined ? undefined : uuid.safeParse(query.policyCursor);
  const auditQuery = AuditQuery.safeParse(Object.fromEntries(["cursor", "action", "targetType", "targetId", "actorId", "fromInstant", "toInstantExclusive"].filter(key => query[key] !== undefined && query[key] !== "").map(key => [key, query[key]])));
  if (!org.success || !entity.success || (cursor && !cursor.success) || !auditQuery.success) notFound();
  const memberships = await sessionMemberships(identity.user.id);
  const member = memberships.find(m => m.organizationId === org.data && m.allowedEntityIds.includes(entity.data));
  const permissions = permissionsFor(member?.roleIds ?? []);
  if (!permissions.has("approvals.read")) notFound();
  const [company, policies, audit] = await Promise.all([
    getEntity(identity.user.id, org.data, entity.data), listPolicies(identity.user.id, org.data, entity.data, 25, cursor?.data),
    permissions.has("audit.read") ? listAudit(identity.user.id, org.data, entity.data, auditQuery.data) : Promise.resolve(null),
  ]);
  return <ControlsWorkspace key={`${org.data}-${entity.data}-${cursor?.data ?? "first"}-${auditQuery.data.cursor ?? "first"}`} entity={company} policies={policies.data} policyCursor={policies.nextCursor}
    currentUserId={identity.user.id} today={localDate(new Date())} canCreate={permissions.has("approvals.create")}
    canActivate={permissions.has("approval_policies.activate") && Boolean(member?.roleIds.some(role => role === "organization_admin" || role === "finance_manager"))}
    audit={audit} auditQuery={auditQuery.data} paginated={Boolean(cursor || auditQuery.data.cursor)} />;
}
