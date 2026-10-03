import { api, currentUser, result } from "@/features/platform/http";
import { uuid } from "@/features/platform/contracts";
import { getPeriod } from "@/features/accounting/setup-service";
export async function GET(request: Request, context: { params: Promise<{ orgId: string; entityId: string; id: string }> }) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params;
    const period = await getPeriod(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), uuid.parse(p.id)); return result(period, requestId, { version: period.version });
  });
}
