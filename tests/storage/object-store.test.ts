import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { setTimeout as pause } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CreateBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, DeleteBucketCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { startStorage } from "@/scripts/storage-process";
import { storageClient } from "@/features/documents/storage-config";

describe("real private persistent object store", () => {
  let service: Awaited<ReturnType<typeof startStorage>>, client: ReturnType<typeof storageClient>;
  let env: NodeJS.ProcessEnv, data: string;
  const bucket = `test-${randomUUID()}`, key = `quarantine/${randomUUID()}/fixture.txt`, body = "Fictional evidence परीक्षण";
  beforeAll(async () => {
    const port = await new Promise<number>((ok, fail) => {
      const probe = createServer(); probe.once("error", fail);
      probe.listen(0, "127.0.0.1", () => { const address = probe.address(); if (!address || typeof address === "string") return fail(new Error("No test port")); probe.close(() => ok(address.port)); });
    });
    env = { NODE_ENV: "test", S3_ENDPOINT: `http://127.0.0.1:${port}`, S3_REGION: "us-east-1", S3_BUCKET: bucket, S3_ACCESS_KEY_ID: randomBytes(16).toString("hex"), S3_SECRET_ACCESS_KEY: randomBytes(32).toString("hex") };
    mkdirSync(".local/storage-tests", { recursive: true }); data = mkdtempSync(resolve(".local/storage-tests/run-"));
    service = await startStorage(env, data); client = storageClient(env);
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "text/plain" }));
  });
  afterAll(async () => {
    try {
      if (client) { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); await client.send(new DeleteBucketCommand({ Bucket: bucket })); }
    } finally { client?.destroy(); await service?.stop(); }
  });
  it("retrieves authenticated content and denies anonymous reads and listings", async () => {
    const stored = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    expect(await stored.Body!.transformToString()).toBe(body);
    expect((await fetch(`${env.S3_ENDPOINT}/${bucket}/${key}`)).status).toBe(403);
    expect((await fetch(`${env.S3_ENDPOINT}/${bucket}?list-type=2`)).status).toBe(403);
  });
  it("rejects wrong credentials", async () => {
    const wrong = storageClient({ ...env, S3_SECRET_ACCESS_KEY: randomBytes(32).toString("hex") });
    try { await expect(wrong.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } }); }
    finally { wrong.destroy(); }
  });
  it("verifies signatures and expiry on temporary access", async () => {
    const signed = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentDisposition: 'attachment; filename="fixture.txt"' }), { expiresIn: 1 });
    const response = await fetch(signed); expect(response.status).toBe(200); expect(response.headers.get("content-disposition")).toContain("attachment");
    const tampered = new URL(signed); tampered.searchParams.set("X-Amz-Signature", "0".repeat(64));
    expect((await fetch(tampered)).status).toBe(403);
    await pause(2100); expect((await fetch(signed)).status).toBe(403);
  });
  it("preserves content across a service restart", async () => {
    await service.stop(); service = await startStorage(env, data);
    const stored = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    expect(await stored.Body!.transformToString()).toBe(body);
  });
  it("does not silently connect to an occupied endpoint", async () => {
    await expect(startStorage(env, data)).rejects.toThrow("already in use");
  });
});
