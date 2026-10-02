import { api, currentUser, result } from "@/features/platform/http";
import { uuid } from "@/features/platform/contracts";
import { AuditQuery } from "@/features/approvals/contracts";
import { listAudit } from "@/features/approvals/service";
type Context = { params: Promise<{ orgId: string; entityId: string }> };
export async function GET(request: Request, context: Context) {
  return api(request, async id => {
    const user = await currentUser(request), p = await context.params, q = AuditQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
    const list = await listAudit(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), q);
    return result(list.data, id, { nextCursor: list.nextCursor });
  });
}
