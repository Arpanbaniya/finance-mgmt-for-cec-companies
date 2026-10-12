import { api, currentUser, result } from "@/features/platform/http";
import { parseReportQuery } from "@/features/reporting/report-query";
import { readReport } from "@/features/reporting/report-service";
type Context = { params: Promise<{ orgId: string; entityId: string; reportType: string }> };
export async function GET(request: Request, context: Context) {
  return api(request, async requestId => {
    const user = await currentUser(request), params = await context.params;
    const query = parseReportQuery(params.reportType, new URL(request.url).searchParams);
    return result(await readReport(user.id, params.orgId, params.entityId, query), requestId);
  });
}
