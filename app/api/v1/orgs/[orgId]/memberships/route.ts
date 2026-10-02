import { api, body, currentUser, idempotencyKey, result } from "@/features/platform/http";
import { ListQuery, MembershipChange, uuid } from "@/features/platform/contracts";
import { listMembers, changeMember } from "@/features/platform/memberships";
type Context = { params: Promise<{ orgId: string }> };
export async function GET(request: Request, context: Context) {
  return api(request, async id => {
    const user = await currentUser(request), org = uuid.parse((await context.params).orgId), query = ListQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
    const rows = await listMembers(user.id, org, query.limit, query.cursor); return result(rows.data, id, { nextCursor: rows.nextCursor });
  });
}
export async function POST(request: Request, context: Context) {
  return api(request, async id => {
    const user = await currentUser(request), org = uuid.parse((await context.params).orgId), input = MembershipChange.parse(await body(request));
    const member = await changeMember(user.id, org, input, id, { key: idempotencyKey(request) }); return result(member, id, { status: 201, version: member.version });
  });
}
