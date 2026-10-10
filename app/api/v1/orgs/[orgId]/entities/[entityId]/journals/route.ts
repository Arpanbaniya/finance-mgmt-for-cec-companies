import { api, currentUser, body, idempotencyKey, result } from "@/features/platform/http";
import { uuid, ListQuery } from "@/features/platform/contracts";
import { JournalCreate } from "@/features/accounting/journal-contracts";
import { listJournals, createJournal } from "@/features/accounting/journal-service";
type Context = { params: Promise<{ orgId: string; entityId: string }> };
export async function GET(request: Request, context: Context) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params, query = ListQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
    const page = await listJournals(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), query.limit, query.cursor);
    return result(page.data, requestId, { nextCursor: page.nextCursor });
  });
}
export async function POST(request: Request, context: Context) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params;
    const journal = await createJournal(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), JournalCreate.parse(await body(request, 300000)), idempotencyKey(request), requestId);
    return result(journal, requestId, { status: 201, version: journal.version, location: `/api/v1/orgs/${p.orgId}/entities/${p.entityId}/journals/${journal.id}` });
  });
}
