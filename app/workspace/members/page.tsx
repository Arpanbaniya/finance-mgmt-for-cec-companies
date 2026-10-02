import { headers } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { configured } from "@/db/client";
import { auth } from "@/features/identity/auth";
import { sessionMemberships } from "@/features/identity/session";
import { listEntities } from "@/features/platform/service";
import { listMembers } from "@/features/platform/memberships";
import { uuid } from "@/features/platform/contracts";
import { MembershipWorkspace } from "@/features/platform/membership-workspace";

export const dynamic = "force-dynamic";
export const metadata = { title: "Membership administration" };

export default async function MembersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!configured()) redirect("/sign-in");
  const identity = await auth().api.getSession({ headers: await headers() });
  if (!identity) redirect("/sign-in");
  const query = await searchParams;
  const organization = uuid.safeParse(query.org), cursor = query.cursor === undefined ? undefined : uuid.safeParse(query.cursor);
  if (!organization.success || (cursor && !cursor.success)) notFound();
  const memberships = await sessionMemberships(identity.user.id);
  if (!memberships.some(m => m.organizationId === organization.data && m.roleIds.includes("organization_admin"))) notFound();
  const [members, entities] = await Promise.all([
    listMembers(identity.user.id, organization.data, 25, cursor?.data),
    listEntities(identity.user.id, organization.data, 100),
  ]);
  return <MembershipWorkspace key={`${organization.data}-${cursor?.data ?? "first"}`} organizationId={organization.data} currentUserId={identity.user.id} members={members.data} nextCursor={members.nextCursor} entities={entities.data} entityChoicesTruncated={entities.nextCursor !== null} paginated={Boolean(cursor)} />;
}
