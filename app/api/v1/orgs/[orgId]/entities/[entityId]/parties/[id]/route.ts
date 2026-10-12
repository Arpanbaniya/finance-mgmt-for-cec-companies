import { api, currentUser, body, expectedVersion, result } from "@/features/platform/http";
import { uuid } from "@/features/platform/contracts";
import { PartyPatch } from "@/features/parties/contracts";
import { getParty, patchParty } from "@/features/parties/service";
type Context = { params: Promise<{ orgId: string; entityId: string; id: string }> };
export async function GET(request: Request, context: Context) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params;
    const party = await getParty(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), uuid.parse(p.id));
    return result(party, requestId, { version: party.version });
  });
}
export async function PATCH(request: Request, context: Context) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params, version = expectedVersion(request);
    const party = await patchParty(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), uuid.parse(p.id), PartyPatch.parse(await body(request)), version, requestId);
    return result(party, requestId, { version: party.version });
  });
}
