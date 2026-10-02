import { expect, it } from "vitest";
import { runtimeRole } from "@/db/runtime-config";
const ref = "abcdefghijklmnopqrst", password = "private-do-not-print";
it("accepts restricted direct and project-qualified Supabase pooler roles", () => {
  expect(runtimeRole(`postgresql://kaamledger_app:${password}@127.0.0.1:55432/kaamledger`)).toBe("kaamledger_app");
  expect(runtimeRole(`postgresql://kaamledger_app.${ref}:${password}@aws-0-ap-south-1.pooler.supabase.com:6543/postgres`, ref)).toBe("kaamledger_app");
});
it.each(["postgres", "supabase_admin", `kaamledger_app.${ref}x`, `postgres.${ref}`])("rejects elevated or wrong-project runtime usernames %s", username => {
  expect(() => runtimeRole(`postgresql://${username}:${password}@aws-0-ap-south-1.pooler.supabase.com:6543/postgres`, ref)).toThrow("restricted");
});
it("rejects disguised pooler hosts, missing metadata and malformed URLs without leaking credentials", () => {
  for (const [url, project] of [[`postgresql://kaamledger_app.${ref}:${password}@pooler.supabase.com.evil.invalid/postgres`, ref], [`postgresql://kaamledger_app.${ref}:${password}@aws-0-ap-south-1.pooler.supabase.com/postgres`, undefined], [`https://kaamledger_app:${password}@example.invalid/postgres`, ref], [password, ref]]) {
    try { runtimeRole(url!, project); throw new Error("Expected failure"); } catch (error) { expect(String(error)).toContain("configuration"); expect(String(error)).not.toContain(password); }
  }
});
