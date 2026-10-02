import { api, currentUser, result } from "@/features/platform/http";
import { sessionMemberships } from "@/features/identity/session";
export async function GET(request: Request) {
  return api(request, async id => { const user = await currentUser(request); return result({ user: { id: user.id, name: user.name, email: user.email }, memberships: await sessionMemberships(user.id) }, id); });
}
