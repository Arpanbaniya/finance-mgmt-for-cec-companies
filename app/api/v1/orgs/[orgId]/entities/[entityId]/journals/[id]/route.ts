import { api, currentUser, body, expectedVersion, result } from "@/features/platform/http";
import { uuid } from "@/features/platform/contracts";
import { JournalPatch } from "@/features/accounting/journal-contracts";
import { getJournal, patchJournal } from "@/features/accounting/journal-service";
type Context = { params: Promise<{ orgId: string; entityId: string; id: string }> };
export async function GET(request: Request, context: Context) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params;
    const journal = await getJournal(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), uuid.parse(p.id));
    return result(journal, requestId, { version: journal.version });
  });
}
export async function PATCH(request: Request, context: Context) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params;
    const journal = await patchJournal(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), uuid.parse(p.id), JournalPatch.parse(await body(request, 300000)), expectedVersion(request), requestId);
    return result(journal, requestId, { version: journal.version });
  });
}
