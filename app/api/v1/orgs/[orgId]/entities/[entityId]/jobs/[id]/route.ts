import { api, currentUser, result } from "@/features/platform/http";
import { uuid } from "@/features/platform/contracts";
import { getJob } from "@/features/jobs/service";
export async function GET(request: Request, context: { params: Promise<{ orgId: string; entityId: string; id: string }> }) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params;
    const job = await getJob(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), uuid.parse(p.id));
    return result(job, requestId, { version: job.version });
  });
}
