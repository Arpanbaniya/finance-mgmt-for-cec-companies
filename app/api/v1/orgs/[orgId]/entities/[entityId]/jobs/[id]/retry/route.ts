import { api, currentUser, body, expectedVersion, idempotencyKey, result } from "@/features/platform/http";
import { uuid } from "@/features/platform/contracts";
import { Reason } from "@/features/jobs/contracts";
import { retryJob } from "@/features/jobs/service";
export async function POST(request: Request, context: { params: Promise<{ orgId: string; entityId: string; id: string }> }) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params;
    const version = expectedVersion(request), key = idempotencyKey(request);
    const job = await retryJob(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), uuid.parse(p.id), Reason.parse(await body(request)), version, key, requestId);
    return result(job, requestId, { status: 202, version: job.version, location: job.statusUrl });
  });
}
