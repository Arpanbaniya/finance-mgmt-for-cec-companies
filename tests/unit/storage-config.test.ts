import { describe, expect, it } from "vitest";
import { storageConfig } from "@/features/documents/storage-config";

const env = { S3_ENDPOINT: "http://127.0.0.1:59000", S3_REGION: "us-east-1", S3_BUCKET: "kaamledger-evidence", S3_ACCESS_KEY_ID: "a".repeat(32), S3_SECRET_ACCESS_KEY: "b".repeat(64), NODE_ENV: "test" };
describe("private storage configuration", () => {
  it("permits loopback development and private HTTPS production endpoints", () => {
    expect(storageConfig(env).S3_BUCKET).toBe("kaamledger-evidence");
    expect(storageConfig({ ...env, NODE_ENV: "production", S3_ENDPOINT: "https://s3.example.com" }).S3_REGION).toBe("us-east-1");
  });
  it.each([
    { S3_ENDPOINT: "http://192.168.1.10:9000" }, { NODE_ENV: "production" }, { VERCEL: "1" },
    { S3_ENDPOINT: "https://user:password@s3.example.com" }, { S3_ENDPOINT: "https://s3.example.com/path" },
    { S3_ENDPOINT: "https://s3.example.com?token=secret" }, { S3_BUCKET: "invalid/bucket" },
  ])("rejects unsafe endpoint or bucket configuration %j", override => {
    expect(() => storageConfig({ ...env, ...override })).toThrow();
  });
  it("does not expose secrets through validation errors", () => {
    const secret = "sensitive-do-not-log";
    try { storageConfig({ ...env, S3_SECRET_ACCESS_KEY: secret }); throw new Error("Expected validation failure"); }
    catch (error) { expect(String(error)).not.toContain(secret); expect(String(error)).toContain("configuration"); }
  });
});
