import { api, currentUser, body, idempotencyKey, result } from "@/features/platform/http";
import { uuid } from "@/features/platform/contracts";
import { DocumentUploadRequest } from "@/features/documents/contracts";
import { requestRuleEvidenceUpload } from "@/features/documents/service";
type Context = { params: Promise<{ orgId: string; entityId: string }> };
export async function POST(request: Request, context: Context) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params;
    const grant = await requestRuleEvidenceUpload(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), DocumentUploadRequest.parse(await body(request)), idempotencyKey(request), requestId);
    return result(grant, requestId, { status: 201, version: grant.document.version, location: `/api/v1/orgs/${p.orgId}/entities/${p.entityId}/documents/${grant.documentId}` });
  });
}
