import { api, currentUser, body, expectedVersion, idempotencyKey, result } from "@/features/platform/http";
import { uuid } from "@/features/platform/contracts";
import { Reason } from "@/features/alerts/contracts";
import { rejectJournal } from "@/features/accounting/journal-service";
type Context = { params: Promise<{ orgId: string; entityId: string; id: string }> };
export async function POST(request: Request, context: Context) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params, version = expectedVersion(request), key = idempotencyKey(request);
    const command = await rejectJournal(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), uuid.parse(p.id), Reason.parse(await body(request)), version, key, requestId);
    return result(command, requestId, { version: command.version });
  });
}
