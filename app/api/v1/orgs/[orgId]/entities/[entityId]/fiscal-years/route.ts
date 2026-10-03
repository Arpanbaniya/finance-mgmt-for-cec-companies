import { api, currentUser, body, idempotencyKey, result } from "@/features/platform/http";
import { uuid, ListQuery } from "@/features/platform/contracts";
import { PeriodCreate } from "@/features/accounting/setup-contracts";
import { listFiscalYears, createFiscalYear } from "@/features/accounting/setup-service";
type Context = { params: Promise<{ orgId: string; entityId: string }> };
export async function GET(request: Request, context: Context) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params, query = ListQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
    const page = await listFiscalYears(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), query.limit, query.cursor); return result(page.data, requestId, { nextCursor: page.nextCursor });
  });
}
export async function POST(request: Request, context: Context) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params;
    const year = await createFiscalYear(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), PeriodCreate.parse(await body(request)), idempotencyKey(request), requestId);
    return result(year, requestId, { status: 201, version: year.version, location: `/api/v1/orgs/${p.orgId}/entities/${p.entityId}/fiscal-years` });
  });
}
