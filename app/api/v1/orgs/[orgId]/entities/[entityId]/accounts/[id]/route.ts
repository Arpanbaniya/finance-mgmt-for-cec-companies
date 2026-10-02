import { api, currentUser, body, expectedVersion, result } from "@/features/platform/http";
import { uuid } from "@/features/platform/contracts";
import { AccountPatch } from "@/features/accounting/contracts";
import { getAccount, patchAccount } from "@/features/accounting/accounts-service";
type Context = { params: Promise<{ orgId: string; entityId: string; id: string }> };
export async function GET(request: Request, context: Context) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params;
    const account = await getAccount(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), uuid.parse(p.id));
    return result(account, requestId, { version: account.version });
  });
}
export async function PATCH(request: Request, context: Context) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params, version = expectedVersion(request);
    const account = await patchAccount(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), uuid.parse(p.id), AccountPatch.parse(await body(request)), version, requestId);
    return result(account, requestId, { version: account.version });
  });
}
