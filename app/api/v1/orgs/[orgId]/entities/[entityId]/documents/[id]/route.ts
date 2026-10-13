import { api, currentUser, result } from "@/features/platform/http";
import { uuid } from "@/features/platform/contracts";
import { getPendingDocument } from "@/features/documents/service";
type Context = { params: Promise<{ orgId: string; entityId: string; id: string }> };
export async function GET(request: Request, context: Context) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params;
    const document = await getPendingDocument(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), uuid.parse(p.id));
    return result(document, requestId, { version: document.version });
  });
}
