import { api, currentUser, body, expectedVersion, idempotencyKey, result } from "@/features/platform/http";
import { uuid } from "@/features/platform/contracts";
import { Reason } from "@/features/alerts/contracts";
import { acknowledgeAlert } from "@/features/alerts/service";
export async function POST(request: Request, context: { params: Promise<{ orgId: string; entityId: string; id: string }> }) {
  return api(request, async requestId => {
    const user = await currentUser(request), params = await context.params;
    const version = expectedVersion(request), key = idempotencyKey(request);
    const command = await acknowledgeAlert(user.id, uuid.parse(params.orgId), uuid.parse(params.entityId), uuid.parse(params.id), Reason.parse(await body(request)), version, key, requestId);
    return result(command, requestId, { version: command.version });
  });
}
