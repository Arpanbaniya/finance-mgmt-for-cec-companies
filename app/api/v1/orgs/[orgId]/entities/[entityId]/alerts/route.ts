import { api, currentUser, result } from "@/features/platform/http";
import { uuid, ListQuery } from "@/features/platform/contracts";
import { listAlerts } from "@/features/alerts/service";
export async function GET(request: Request, context: { params: Promise<{ orgId: string; entityId: string }> }) {
  return api(request, async requestId => {
    const user = await currentUser(request), params = await context.params;
    const query = ListQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
    const page = await listAlerts(user.id, uuid.parse(params.orgId), uuid.parse(params.entityId), query.limit, query.cursor);
    return result(page.data, requestId, { nextCursor: page.nextCursor });
  });
}
