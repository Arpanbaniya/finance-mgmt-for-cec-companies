import { auth } from "@/features/identity/auth";
import { configured } from "@/db/client";

async function handler(request: Request) {
  if (!configured()) return Response.json({ error: { code: "SERVICE_UNAVAILABLE", message: "Sign-in is awaiting database configuration." } }, { status: 503, headers: { "Cache-Control": "no-store" } });
  if (request.method === "POST") {
    const origin = request.headers.get("origin"), expected = new URL(process.env.BETTER_AUTH_URL!).origin;
    if ((origin && origin !== expected) || request.headers.get("sec-fetch-site") === "cross-site") {
      return Response.json({ error: { code: "FORBIDDEN", message: "Request origin is not allowed." } }, { status: 403, headers: { "Cache-Control": "no-store" } });
    }
  }
  // Public account registration and password reset delivery are not active scope.
  const path = new URL(request.url).pathname;
  const allowed = ["/api/auth/sign-in/email", "/api/auth/sign-out", "/api/auth/get-session", "/api/auth/list-sessions", "/api/auth/revoke-session", "/api/auth/revoke-sessions", "/api/auth/revoke-other-sessions"];
  if (!allowed.includes(path)) return Response.json({ error: { code: "NOT_FOUND", message: "This authentication operation is unavailable." } }, { status: 404 });
  const response = await auth().handler(request); response.headers.set("Cache-Control", "private, no-store"); return response;
}
export const GET = handler;
export const POST = handler;
