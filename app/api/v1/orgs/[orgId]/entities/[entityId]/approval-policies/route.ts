import { api, body, currentUser, idempotencyKey, result } from "@/features/platform/http";
import { uuid, ListQuery } from "@/features/platform/contracts";
import { ApprovalPolicyCreate } from "@/features/approvals/contracts";
import { createPolicy, listPolicies } from "@/features/approvals/service";
type Context = { params: Promise<{ orgId: string; entityId: string }> };
export async function GET(request: Request, context: Context) {
  return api(request, async id => {
    const user = await currentUser(request), p = await context.params, q = ListQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
    const list = await listPolicies(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), q.limit, q.cursor);
    return result(list.data, id, { nextCursor: list.nextCursor });
  });
}
export async function POST(request: Request, context: Context) {
  return api(request, async id => {
    const user = await currentUser(request), p = await context.params;
    const policy = await createPolicy(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), ApprovalPolicyCreate.parse(await body(request)), idempotencyKey(request), id);
    return result(policy, id, { status: 201, version: policy.version, location: `/api/v1/orgs/${policy.organizationId}/entities/${policy.entityId}/approval-policies/${policy.id}` });
  });
}
