import { z } from "zod";
import { EntityCreate, EntityPatch, EntityDTO, MembershipChange, MembershipDTO, HealthDTO, ListQuery } from "./contracts";
import { catalogRows, implementedRoutes } from "@/scripts/route-parity";
import { ApprovalPolicyCreate, ApprovalPolicyDTO, AuditQuery, AuditEventDTO, CommandResult, Transition } from "@/features/approvals/contracts";
import { AlertDTO, AlertCommandResult, Reason } from "@/features/alerts/contracts";
import { JobDTO, JobResult } from "@/features/jobs/contracts";
import { AccountDTO, AccountCreate, AccountPatch } from "@/features/accounting/contracts";

const SessionContext = z.strictObject({ user: z.strictObject({ id: z.string(), name: z.string(), email: z.email() }), memberships: z.array(MembershipDTO) });
const meta = z.strictObject({ requestId: z.string(), version: z.number().int().optional(), nextCursor: z.uuid().nullable().optional() });
const error = z.strictObject({ error: z.strictObject({ code: z.string(), message: z.string(), requestId: z.string(), retryable: z.boolean(), fieldErrors: z.array(z.strictObject({ path: z.string(), message: z.string() })) }) });
const responses = { Health: HealthDTO, SessionContext, Entity: EntityDTO, EntityList: z.array(EntityDTO), Membership: MembershipDTO, MembershipList: z.array(MembershipDTO), ApprovalPolicy: ApprovalPolicyDTO, ApprovalPolicyList: z.array(ApprovalPolicyDTO), AuditEventList: z.array(AuditEventDTO), AlertList: z.array(AlertDTO), Job: JobDTO, JobResult, Account: AccountDTO, AccountList: z.array(AccountDTO), CommandResult: z.discriminatedUnion("status", [CommandResult, AlertCommandResult]) };
const requests = { EntityCreate, EntityPatch, MembershipChange, ListQuery, ApprovalPolicyCreate, AuditQuery, Transition, Reason, AccountCreate, AccountPatch, NoBody: z.strictObject({}) };
export function openapi() {
  const schemas: Record<string, unknown> = { Error: z.toJSONSchema(error, { unrepresentable: "any" }) };
  for (const [name, schema] of Object.entries(requests)) schemas[name] = z.toJSONSchema(schema, { unrepresentable: "any" });
  for (const [name, schema] of Object.entries(responses)) schemas[name] = z.toJSONSchema(z.strictObject({ data: schema, meta }));
  const catalog = catalogRows(), paths: Record<string, Record<string, unknown>> = {};
  for (const route of implementedRoutes()) {
    const row = catalog.find(r => r.method === route.method && r.path === route.path)!;
    if (!row || !Object.hasOwn(requests, row.request_schema) || !Object.hasOwn(responses, row.response_schema)) throw new Error(`Missing concrete contract for ${route.method} ${route.path}`);
    const parameters: Record<string, unknown>[] = [...route.path.matchAll(/\{([^}]+)\}/g)].map(m => ({ name: m[1], in: "path", required: true, schema: { type: "string", format: "uuid" } }));
    if (row.request_schema === "ListQuery") parameters.push({ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } }, { name: "cursor", in: "query", schema: { type: "string", format: "uuid" } });
    if (row.request_schema === "AuditQuery") {
      const query = z.toJSONSchema(AuditQuery, { unrepresentable: "any" });
      for (const [name, schema] of Object.entries(query.properties ?? {})) parameters.push({ name, in: "query", schema: name === "limit" ? { type: "integer", minimum: 1, maximum: 100, default: 25 } : schema });
    }
    if (row.idempotency === "required") parameters.push({ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 8, maxLength: 200, pattern: "^[A-Za-z0-9_.-]+$" } });
    if (row.if_match === "required") parameters.push({ name: "If-Match", in: "header", required: true, schema: { type: "string", pattern: '^"[1-9][0-9]*"$' } });
    const status = row.response_schema === "JobResult" ? "202" : route.method === "POST" && row.response_schema !== "CommandResult" && !route.path.endsWith("/archive") ? "201" : "200";
    paths[route.path] ??= {};
    paths[route.path][route.method.toLowerCase()] = {
      operationId: row.operation_id, "x-permission": row.permission,
      parameters, security: row.permission === "public" ? [] : [{ sessionCookie: [] }],
      ...(route.method === "POST" || route.method === "PATCH" ? { requestBody: { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${row.request_schema}` } } } } } : {}),
      responses: { [status]: { description: "Success", headers: { ...(["Entity", "Membership", "ApprovalPolicy", "CommandResult", "Job", "JobResult", "Account"].includes(row.response_schema) ? { ETag: { schema: { type: "string" } } } : {}), ...(["201", "202"].includes(status) ? { Location: { schema: { type: "string" } } } : {}) }, content: { "application/json": { schema: { $ref: `#/components/schemas/${row.response_schema}` } } } }, ...Object.fromEntries([400, 401, 403, 404, 409, 412, 413, 422, 428, 503].map(code => [String(code), { description: "Domain or request error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }])) }
    };
  }
  return { openapi: "3.1.0", info: { title: "KaamLedger R1 — implemented foundation operations", version: "0.1.0", description: `${implementedRoutes().length} implemented operations from a 256-operation planned R1 catalog. Auth adapter operations are provided separately by Better Auth. Later domain operations are not exposed.` }, paths, components: { schemas, securitySchemes: { sessionCookie: { type: "apiKey", in: "cookie", name: "better-auth.session_token", description: "HTTPS uses the __Secure- prefix." } } } };
}
