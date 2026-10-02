import { api, body, currentUser, expectedVersion, result } from "@/features/platform/http";
import { MembershipChange, uuid } from "@/features/platform/contracts";
import { changeMember } from "@/features/platform/memberships";
type Context = { params: Promise<{ orgId: string; id: string }> };
export async function PATCH(request: Request, context: Context) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params, input = MembershipChange.parse(await body(request));
    const member = await changeMember(user.id, uuid.parse(p.orgId), input, requestId, { id: uuid.parse(p.id), version: expectedVersion(request) }); return result(member, requestId, { version: member.version });
  });
}
