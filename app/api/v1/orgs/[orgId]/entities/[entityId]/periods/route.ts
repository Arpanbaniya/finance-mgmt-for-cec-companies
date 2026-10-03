import { api, currentUser, result } from "@/features/platform/http";
import { uuid, ListQuery } from "@/features/platform/contracts";
import { listPeriods } from "@/features/accounting/setup-service";
export async function GET(request: Request, context: { params: Promise<{ orgId: string; entityId: string }> }) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params, query = ListQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
    const page = await listPeriods(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), query.limit, query.cursor); return result(page.data, requestId, { nextCursor: page.nextCursor });
  });
}
