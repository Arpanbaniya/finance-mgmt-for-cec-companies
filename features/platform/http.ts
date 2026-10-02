import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { DomainError } from "@/domain/errors";
import { auth } from "@/features/identity/auth";
import { configured } from "@/db/client";

export async function currentUser(request: Request) {
  if (!configured()) throw new DomainError("SERVICE_UNAVAILABLE", "Sign-in is awaiting database configuration.", 503);
  const session = await auth().api.getSession({ headers: request.headers });
  if (!session) throw new DomainError("UNAUTHENTICATED", "Sign in to continue.", 401);
  return session.user;
}
export function expectedVersion(request: Request): number {
  const value = request.headers.get("If-Match");
  if (!value) throw new DomainError("PRECONDITION_REQUIRED", "Send the current ETag as If-Match.", 428);
  if (!/^"[1-9]\d*"$/.test(value)) throw new DomainError("INVALID_VERSION", "Use the resource's quoted integer ETag.", 400);
  const parsed = Number(value.slice(1, -1));
  if (!Number.isSafeInteger(parsed)) throw new DomainError("INVALID_VERSION", "Version is out of range.", 400);
  return parsed;
}
export function idempotencyKey(request: Request): string {
  const key = request.headers.get("Idempotency-Key");
  if (!key || !/^[\w.-]{8,200}$/.test(key)) throw new DomainError("IDEMPOTENCY_REQUIRED", "Send a stable Idempotency-Key of 8–200 characters.", 400);
  return key;
}
export async function body(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json")) throw new DomainError("INVALID_CONTENT_TYPE", "Use application/json.", 400);
  const content = await request.text();
  if (content.length > 64000) throw new DomainError("BODY_TOO_LARGE", "Request is too large.", 413);
  try { return JSON.parse(content); } catch { throw new DomainError("INVALID_JSON", "Request JSON is malformed.", 400); }
}
export async function api(request: Request, run: (requestId: string) => Promise<Response>): Promise<Response> {
  const requestId = randomUUID();
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      const origin = request.headers.get("origin");
      const expected = process.env.BETTER_AUTH_URL ? new URL(process.env.BETTER_AUTH_URL).origin : new URL(request.url).origin;
      if (origin && origin !== expected) throw new DomainError("FORBIDDEN", "Request origin is not allowed.", 403);
    }
    const response = await run(requestId);
    response.headers.set("Cache-Control", "private, no-store"); response.headers.set("X-Request-Id", requestId);
    return response;
  } catch (e) {
    let status = 500, code = "INTERNAL_ERROR", message = "The request could not be completed.";
    if (e instanceof DomainError) { status = e.status; code = e.code; message = e.message; }
    if (e instanceof ZodError) { status = 422; code = "VALIDATION_ERROR"; message = "Check the supplied fields."; }
    if (typeof e === "object" && e && "code" in e && ["23503", "23505", "23514", "P0001"].includes(String(e.code))) { status = 409; code = "CONFLICT"; message = "The change conflicts with existing data or access constraints."; }
    if (status === 500) console.error(JSON.stringify({ requestId, code, errorType: e instanceof Error ? e.name : "unknown" }));
    return Response.json({ error: { code, message, fieldErrors: e instanceof ZodError ? e.issues.map(i => ({ path: i.path.join("."), message: i.message })) : [], requestId, retryable: status === 503 } }, { status, headers: { "Cache-Control": "private, no-store", "X-Request-Id": requestId } });
  }
}
export function result(data: unknown, requestId: string, options: { status?: number; version?: number; location?: string; nextCursor?: string | null } = {}): Response {
  return Response.json({ data, meta: { requestId, ...(options.version ? { version: options.version } : {}), ...(options.nextCursor !== undefined ? { nextCursor: options.nextCursor } : {}) } }, {
    status: options.status ?? 200, headers: { ...(options.version ? { ETag: `"${options.version}"` } : {}), ...(options.location ? { Location: options.location } : {}) }
  });
}
