import { api, currentUser, body, idempotencyKey, result } from "@/features/platform/http";
import { uuid, ListQuery } from "@/features/platform/contracts";
import { PartyCreate } from "@/features/parties/contracts";
import { listParties, createParty } from "@/features/parties/service";
type Context = { params: Promise<{ orgId: string; entityId: string }> };
export async function GET(request: Request, context: Context) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params, query = ListQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
    const page = await listParties(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), query.limit, query.cursor);
    return result(page.data, requestId, { nextCursor: page.nextCursor });
  });
}
export async function POST(request: Request, context: Context) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params, key = idempotencyKey(request);
    const party = await createParty(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), PartyCreate.parse(await body(request)), key, requestId);
    return result(party, requestId, { status: 201, version: party.version, location: `/api/v1/orgs/${p.orgId}/entities/${p.entityId}/parties/${party.id}` });
  });
}
