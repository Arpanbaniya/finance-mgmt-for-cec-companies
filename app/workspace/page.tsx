import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { configured } from "@/db/client";
import { auth } from "@/features/identity/auth";
import { sessionMemberships } from "@/features/identity/session";
import { listEntities } from "@/features/platform/service";
import { Workspace } from "@/features/platform/workspace";
export const dynamic = "force-dynamic";
export const metadata = { title: "Company workspace" };
export default async function WorkspacePage() {
  if (!configured()) redirect("/sign-in");
  const identity = await auth().api.getSession({ headers: await headers() });
  if (!identity) redirect("/sign-in");
  const memberships = await sessionMemberships(identity.user.id);
  const organizations = await Promise.all(memberships.map(async member => ({ ...member, entities: (await listEntities(identity.user.id, member.organizationId, 100)).data })));
  return <Workspace name={identity.user.name} organizations={organizations} />;
}
