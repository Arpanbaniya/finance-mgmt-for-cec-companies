import { z } from "zod";
import { EntityCreate, EntityPatch, EntityDTO, MembershipChange, MembershipDTO, HealthDTO, ListQuery } from "./contracts";
import { catalogRows, implementedRoutes } from "@/scripts/route-parity";
import { ApprovalPolicyCreate, ApprovalPolicyDTO, AuditQuery, AuditEventDTO, CommandResult, Transition } from "@/features/approvals/contracts";
import { AlertDTO, AlertCommandResult, Reason } from "@/features/alerts/contracts";
import { JobDTO, JobResult } from "@/features/jobs/contracts";
import { AccountDTO, AccountCreate, AccountPatch } from "@/features/accounting/contracts";
import { FiscalYearDTO, PeriodDTO, PeriodCreate, AccountMappingsDTO, AccountMappingsPatch } from "@/features/accounting/setup-contracts";
import { JournalCreate, JournalPatch, JournalDTO, JournalCancelResult, JournalCommandResult, DateAction } from "@/features/accounting/journal-contracts";
import { ReportQuery, ReportResult, ReportType } from "@/features/reporting/report-contracts";
import { PartyDTO, PartyCreate, PartyPatch } from "@/features/parties/contracts";
import { StatementQuery, PartyStatement } from "@/features/parties/statement-contracts";
import { PolicyDraft, PolicyDraftDTO } from "@/features/rules/contracts";
import { DocumentUploadRequest, DocumentDTO, UploadGrant, UploadComplete } from "@/features/documents/contracts";

const SessionContext = z.strictObject({ user: z.strictObject({ id: z.string(), name: z.string(), email: z.email() }), memberships: z.array(MembershipDTO) });
const meta = z.strictObject({ requestId: z.string(), version: z.number().int().optional(), nextCursor: z.uuid().nullable().optional() });
const error = z.strictObject({ error: z.strictObject({ code: z.string(), message: z.string(), requestId: z.string(), retryable: z.boolean(), fieldErrors: z.array(z.strictObject({ path: z.string(), message: z.string() })) }) });
const responses = { Health: HealthDTO, SessionContext, Entity: EntityDTO, EntityList: z.array(EntityDTO), Membership: MembershipDTO, MembershipList: z.array(MembershipDTO), ApprovalPolicy: ApprovalPolicyDTO, ApprovalPolicyList: z.array(ApprovalPolicyDTO), AuditEventList: z.array(AuditEventDTO), AlertList: z.array(AlertDTO), Job: JobDTO, JobResult, Account: AccountDTO, AccountList: z.array(AccountDTO), Journal: JournalDTO, JournalList: z.array(JournalDTO), FiscalYear: FiscalYearDTO, FiscalYearList: z.array(FiscalYearDTO), Period: PeriodDTO, PeriodList: z.array(PeriodDTO), AccountMappings: AccountMappingsDTO, CommandResult: z.discriminatedUnion("status", [CommandResult, AlertCommandResult, JournalCancelResult, JournalCommandResult]) };
const requests = { EntityCreate, EntityPatch, MembershipChange, ListQuery, ApprovalPolicyCreate, AuditQuery, Transition, Reason, DateAction, AccountCreate, AccountPatch, JournalCreate, JournalPatch, PeriodCreate, AccountMappingsPatch, NoBody: z.strictObject({}) };
export function openapi() {
  const activeRequests = { ...requests, ReportQuery, PartyCreate, PartyPatch, StatementQuery, PolicyDraft, DocumentUploadRequest, UploadComplete }, activeResponses = { ...responses, ReportResult, Party: PartyDTO, PartyList: z.array(PartyDTO), PartyStatement, PolicyDraft: PolicyDraftDTO, PolicyDraftList: z.array(PolicyDraftDTO), Document: DocumentDTO, UploadGrant };
  const schemas: Record<string, unknown> = { Error: z.toJSONSchema(error, { unrepresentable: "any" }) };
  // The catalog intentionally shares PolicyDraft's name for command and resource.
  // Keep its strict input separate from the server-owned response envelope.
  for (const [name, schema] of Object.entries(activeRequests)) schemas[name === "PolicyDraft" ? "PolicyDraftInput" : name] = z.toJSONSchema(schema, { unrepresentable: "any", ...(["PartyCreate", "PartyPatch", "StatementQuery", "PolicyDraft"].includes(name) ? { io: "input" as const } : {}) });
  for (const [name, schema] of Object.entries(activeResponses)) schemas[name] = z.toJSONSchema(z.strictObject({ data: schema, meta }));
  schemas.ReportQuery = { ...(schemas.ReportQuery as object), description: "Report type is the path parameter. Interval dates are required for trial balance, general ledger and P&L; balance sheet requires asOfDate instead. General ledger requires accountId. Only ledger/trial balance accept cursor and limit. Comparative=true and deferred report types return FEATURE_NOT_ENABLED after scope authorization; dimensions are not accepted.", allOf: [
    { if: { properties: { reportType: { enum: ["trial-balance", "general-ledger", "profit-loss"] } } }, then: { required: ["fromDate", "toDateExclusive"], not: { required: ["asOfDate"] } } },
    { if: { properties: { reportType: { const: "balance-sheet" } } }, then: { required: ["asOfDate"], not: { anyOf: [{ required: ["fromDate"] }, { required: ["toDateExclusive"] }] } } },
    { if: { properties: { reportType: { const: "general-ledger" } } }, then: { required: ["accountId"] }, else: { not: { required: ["accountId"] } } },
    { if: { properties: { reportType: { enum: ["profit-loss", "balance-sheet"] } } }, then: { not: { anyOf: [{ required: ["limit"] }, { required: ["cursor"] }] } } },
  ] };
  const catalog = catalogRows(), paths: Record<string, Record<string, unknown>> = {};
  for (const route of implementedRoutes()) {
    const row = catalog.find(r => r.method === route.method && r.path === route.path)!;
    if (!row || !Object.hasOwn(activeRequests, row.request_schema) || !Object.hasOwn(activeResponses, row.response_schema)) throw new Error(`Missing concrete contract for ${route.method} ${route.path}`);
    const parameters: Record<string, unknown>[] = [...route.path.matchAll(/\{([^}]+)\}/g)].map(m => ({ name: m[1], in: "path", required: true, schema: m[1] === "reportType" ? z.toJSONSchema(ReportType) : { type: "string", format: "uuid" } }));
    if (row.request_schema === "ReportQuery") {
      const query = z.toJSONSchema(ReportQuery, { unrepresentable: "any" });
      for (const [name, schema] of Object.entries(query.properties ?? {})) if (name !== "reportType") parameters.push({ name, in: "query", schema });
    }
    if (row.request_schema === "ListQuery") parameters.push({ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } }, { name: "cursor", in: "query", schema: { type: "string", format: "uuid" } });
    if (row.request_schema === "StatementQuery") {
      const query = z.toJSONSchema(StatementQuery, { unrepresentable: "any" });
      for (const [name, schema] of Object.entries(query.properties ?? {})) parameters.push({ name, in: "query", required: name === "asOfDate", schema });
    }
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
      ...(row.request_schema === "ReportQuery" ? { "x-report-query-schema": { $ref: "#/components/schemas/ReportQuery" }, description: "Four current report variants; raw ledger/trial balance require finance access. Owners receive only minimal P&L/balance-sheet aggregates. Scope is rechecked on every page; no cached private results." } : {}),
      parameters, security: row.permission === "public" ? [] : [{ sessionCookie: [] }],
      ...(route.method === "POST" || route.method === "PATCH" ? { requestBody: { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${row.request_schema === "PolicyDraft" ? "PolicyDraftInput" : row.request_schema}` } } } } } : {}),
      responses: { [status]: { description: "Success", headers: { ...(["Entity", "Membership", "ApprovalPolicy", "CommandResult", "Job", "JobResult", "Account", "Party", "Journal", "FiscalYear", "Period", "AccountMappings", "PolicyDraft"].includes(row.response_schema) ? { ETag: { schema: { type: "string" } } } : {}), ...(["201", "202"].includes(status) ? { Location: { schema: { type: "string" } } } : {}) }, content: { "application/json": { schema: { $ref: `#/components/schemas/${row.response_schema}` } } } }, ...Object.fromEntries([400, 401, 403, 404, 409, 412, 413, 422, 428, 503].map(code => [String(code), { description: "Domain or request error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }])) }
    };
  }
  return { openapi: "3.1.0", info: { title: "KaamLedger R1 — implemented foundation operations", version: "0.1.0", description: `${implementedRoutes().length} implemented operations from a 256-operation planned R1 catalog. Auth adapter operations are provided separately by Better Auth. Later domain operations are not exposed.` }, paths, components: { schemas, securitySchemes: { sessionCookie: { type: "apiKey", in: "cookie", name: "better-auth.session_token", description: "HTTPS uses the __Secure- prefix." } } } };
}
