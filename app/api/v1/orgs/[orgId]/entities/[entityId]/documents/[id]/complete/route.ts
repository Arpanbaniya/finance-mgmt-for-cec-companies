import { api, currentUser, body, expectedVersion, idempotencyKey, result } from "@/features/platform/http";
import { uuid } from "@/features/platform/contracts";
import { UploadComplete } from "@/features/documents/contracts";
import { completeRuleEvidenceUpload } from "@/features/documents/service";
type Context = { params: Promise<{ orgId: string; entityId: string; id: string }> };
export async function POST(request: Request, context: Context) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params;
    const document = await completeRuleEvidenceUpload(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), uuid.parse(p.id),
      UploadComplete.parse(await body(request)), expectedVersion(request), idempotencyKey(request), requestId);
    const location = `/api/v1/orgs/${p.orgId}/entities/${p.entityId}/documents/${p.id}`;
    return result(document, requestId, { status: 201, version: document.version, location });
  });
}
