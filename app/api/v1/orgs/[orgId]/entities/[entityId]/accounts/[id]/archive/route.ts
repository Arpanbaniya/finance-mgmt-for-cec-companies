import { api, currentUser, body, expectedVersion, idempotencyKey, result } from "@/features/platform/http";
import { uuid } from "@/features/platform/contracts";
import { Reason } from "@/features/alerts/contracts";
import { archiveAccount } from "@/features/accounting/accounts-service";
export async function POST(request: Request, context: { params: Promise<{ orgId: string; entityId: string; id: string }> }) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params, version = expectedVersion(request), key = idempotencyKey(request);
    const account = await archiveAccount(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), uuid.parse(p.id), Reason.parse(await body(request)), version, key, requestId);
    return result(account, requestId, { version: account.version });
  });
}
