import { api, currentUser, body, expectedVersion, result } from "@/features/platform/http";
import { uuid } from "@/features/platform/contracts";
import { z } from "zod";
import { AccountMappingsPatch } from "@/features/accounting/setup-contracts";
import { getAccountMappings, patchAccountMappings } from "@/features/accounting/setup-service";
type Context = { params: Promise<{ orgId: string; entityId: string }> };
export async function GET(request: Request, context: Context) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params;
    z.strictObject({}).parse(Object.fromEntries(new URL(request.url).searchParams));
    const mappings = await getAccountMappings(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId)); return result(mappings, requestId, { version: mappings.version });
  });
}
export async function PATCH(request: Request, context: Context) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params;
    const mappings = await patchAccountMappings(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), AccountMappingsPatch.parse(await body(request)), expectedVersion(request), requestId); return result(mappings, requestId, { version: mappings.version });
  });
}
