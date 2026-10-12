import { api, currentUser, body, idempotencyKey, result } from "@/features/platform/http";
import { uuid, ListQuery } from "@/features/platform/contracts";
import { PolicyDraft } from "@/features/rules/contracts";
import { listRuleDrafts, createRuleDraft } from "@/features/rules/service";
type Context = { params: Promise<{ orgId: string; entityId: string }> };
export async function GET(request: Request, context: Context) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params, query = ListQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
    const page = await listRuleDrafts(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), query.limit, query.cursor);
    return result(page.data, requestId, { nextCursor: page.nextCursor });
  });
}
export async function POST(request: Request, context: Context) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params, key = idempotencyKey(request);
    const draft = await createRuleDraft(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), PolicyDraft.parse(await body(request)), key, requestId);
    return result(draft, requestId, { status: 201, version: draft.version, location: `/api/v1/orgs/${p.orgId}/entities/${p.entityId}/rule-versions/${draft.id}` });
  });
}
