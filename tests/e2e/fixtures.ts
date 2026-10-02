import { test as base, expect } from "@playwright/test";
import { databasePool } from "@/db/client";
import { randomBytes } from "node:crypto";

export function clientHeaders() {
  // Separate fictional local clients without disabling production rate limits.
  return { "X-Forwarded-For": `2001:db8:${randomBytes(8).toString("hex").match(/.{4}/g)!.join(":")}:0:1` };
}

// Playwright reuses a worker across files; provider instances share this pool.
export const test = base.extend<Record<never, never>, { databaseLifecycle: void }>({
  extraHTTPHeaders: async ({}, runTests) => { await runTests(clientHeaders()); },
  databaseLifecycle: [async ({}, runTests) => {
    try { await runTests(); } finally { await databasePool().end(); }
  }, { scope: "worker", auto: true }],
});
export { expect };
