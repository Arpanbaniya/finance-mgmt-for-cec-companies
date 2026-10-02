import { randomUUID } from "node:crypto";
import { HealthDTO } from "@/features/platform/contracts";
export async function GET() {
  return Response.json({ data: HealthDTO.parse({ status: "ok", release: "R1", version: "0.1.0" }), meta: { requestId: randomUUID() } }, { headers: { "Cache-Control": "no-store" } });
}
