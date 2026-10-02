import { api, body, currentUser, idempotencyKey, result } from "@/features/platform/http";
import { EntityCreate, ListQuery, uuid } from "@/features/platform/contracts";
import { createEntity, listEntities } from "@/features/platform/service";
type Context = { params: Promise<{ orgId: string }> };
export async function GET(request: Request, context: Context) {
  return api(request, async id => {
    const user = await currentUser(request), org = uuid.parse((await context.params).orgId), query = ListQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
    const data = await listEntities(user.id, org, query.limit, query.cursor); return result(data.data, id, { nextCursor: data.nextCursor });
  });
}
export async function POST(request: Request, context: Context) {
  return api(request, async id => {
    const user = await currentUser(request), org = uuid.parse((await context.params).orgId), input = EntityCreate.parse(await body(request));
    const entity = await createEntity(user.id, org, input, idempotencyKey(request), id);
    return result(entity, id, { status: 201, version: entity.version, location: `/api/v1/orgs/${org}/entities/${entity.id}` });
  });
}
