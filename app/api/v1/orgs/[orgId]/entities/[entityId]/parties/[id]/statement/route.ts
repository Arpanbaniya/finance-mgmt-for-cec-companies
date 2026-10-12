import { api, currentUser, result } from "@/features/platform/http";
import { uuid } from "@/features/platform/contracts";
import { parseStatementQuery } from "@/features/parties/statement-query";
import { readPartyStatement } from "@/features/parties/statement-service";
type Context = { params: Promise<{ orgId: string; entityId: string; id: string }> };
export async function GET(request: Request, context: Context) {
  return api(request, async requestId => {
    const user = await currentUser(request), p = await context.params;
    return result(await readPartyStatement(user.id, uuid.parse(p.orgId), uuid.parse(p.entityId), uuid.parse(p.id),
      parseStatementQuery(new URL(request.url).searchParams.entries())), requestId);
  });
}
