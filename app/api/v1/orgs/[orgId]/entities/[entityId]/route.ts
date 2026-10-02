import { api, body, currentUser, expectedVersion, result } from "@/features/platform/http";
import { EntityPatch, uuid } from "@/features/platform/contracts";
import { getEntity, patchEntity } from "@/features/platform/service";
type Context = { params: Promise<{ orgId: string; entityId: string }> };
export async function GET(request: Request, context: Context) {
  return api(request, async id => {
    const user = await currentUser(request), p = await context.params;
    const entity = await getEntity(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId)); return result(entity, id, { version: entity.version });
  });
}
export async function PATCH(request: Request, context: Context) {
  return api(request, async id => {
    const user = await currentUser(request), p = await context.params;
    const entity = await patchEntity(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), EntityPatch.parse(await body(request)), expectedVersion(request), id);
    return result(entity, id, { version: entity.version });
  });
}
