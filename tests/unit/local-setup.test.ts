import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse } from "dotenv";
import { describe, expect, it } from "vitest";

const cli = resolve("node_modules/tsx/dist/cli.mjs"), script = resolve("scripts/setup-local.ts");
function sandbox() { mkdirSync(".local/setup-tests", { recursive: true }); return mkdtempSync(resolve(".local/setup-tests/run-")); }
function setup(cwd: string, extra: Partial<NodeJS.ProcessEnv> = {}) {
  return execFileSync(process.execPath, [cli, script], { cwd, windowsHide: true, env: { ...process.env, NODE_ENV: "test", VERCEL: "", ...extra }, encoding: "utf8", stdio: "pipe" });
}
describe("fresh local setup", () => {
  it("creates private credentials and preserves them on repeated setup", () => {
    const cwd = sandbox(), output = setup(cwd), path = join(cwd, ".env.local");
    const original = readFileSync(path, "utf8"), env = parse(original);
    expect(new URL(env.MIGRATION_DATABASE_URL).password).not.toBe(new URL(env.DATABASE_URL).password);
    expect(env.S3_ACCESS_KEY_ID).toHaveLength(32); expect(env.S3_SECRET_ACCESS_KEY).toHaveLength(64);
    expect(env.BETTER_AUTH_SECRET.length).toBeGreaterThanOrEqual(48);
    for (const key of ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "BETTER_AUTH_SECRET"]) expect(output).not.toContain(env[key]);
    setup(cwd); expect(readFileSync(path, "utf8")).toBe(original);
  });
  it("upgrades existing database setup without changing its credentials", () => {
    const cwd = sandbox(), path = join(cwd, ".env.local"), original = "DATABASE_URL=existing-runtime\nMIGRATION_DATABASE_URL=existing-admin\nBETTER_AUTH_SECRET=existing-secret\n";
    writeFileSync(path, original); setup(cwd);
    expect(readFileSync(path, "utf8").startsWith(original)).toBe(true);
    expect(parse(readFileSync(path)).S3_BUCKET).toBe("kaamledger-evidence");
  });
  it("does not replace incomplete storage configuration", () => {
    const cwd = sandbox(), path = join(cwd, ".env.local"), original = "S3_ACCESS_KEY_ID=preserve-this\n";
    writeFileSync(path, original); expect(() => setup(cwd)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
  });
  it("refuses production execution", () => {
    expect(() => setup(sandbox(), { NODE_ENV: "production" })).toThrow();
    expect(() => setup(sandbox(), { VERCEL: "1" })).toThrow();
  });
});
