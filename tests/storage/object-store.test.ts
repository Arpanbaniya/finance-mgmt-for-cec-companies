import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { setTimeout as pause } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CreateBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, DeleteBucketCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { startStorage } from "@/scripts/storage-process";
import { storageClient } from "@/features/documents/storage-config";
import { quarantineKey, readQuarantineEvidence } from "@/features/documents/quarantine-reader";
import { signQuarantineUpload } from "@/features/documents/upload-grant";

describe("real private persistent object store", () => {
  let service: Awaited<ReturnType<typeof startStorage>>, client: ReturnType<typeof storageClient>;
  let env: NodeJS.ProcessEnv, data: string;
  const bucket = `test-${randomUUID()}`, key = `quarantine/${randomUUID()}/fixture.txt`, body = "Fictional evidence परीक्षण";
  const scope = { organizationId: randomUUID(), entityId: randomUUID() }, documentId = randomUUID(), evidenceKey = quarantineKey(scope, documentId);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=", "base64");
  const declaration = { filename: "Synthetic-source.png", contentType: "image/png" as const, sizeBytes: png.length, sha256: createHash("sha256").update(png).digest("hex") };
  let evidenceETag: string;
  const uploadIds = [randomUUID(), randomUUID(), randomUUID()];
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
    evidenceETag = (await client.send(new PutObjectCommand({ Bucket: bucket, Key: evidenceKey, Body: png, ContentType: "image/png" }))).ETag!;
  });
  afterAll(async () => {
    try {
      if (client) { for (const objectKey of [key, evidenceKey, ...uploadIds.map(id => quarantineKey(scope, id))]) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey })); await client.send(new DeleteBucketCommand({ Bucket: bucket })); }
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
  it("validates actual private evidence bytes after restart, not a client MIME/hash or scan claim", async () => {
    const reference = { ...scope, documentId, declaration, etag: evidenceETag }, storage = { client, bucket };
    const result = await readQuarantineEvidence(reference, scope, storage); expect(result.bytes.equals(png)).toBe(true);
    expect(result).not.toHaveProperty("scanState"); expect(result).not.toHaveProperty("retentionHeld");
    expect((await fetch(`${env.S3_ENDPOINT}/${bucket}/${evidenceKey}`)).status).toBe(403);
    await expect(readQuarantineEvidence({ ...reference, declaration: { ...declaration, sha256: "a".repeat(64) } }, scope, storage)).rejects.toMatchObject({ code: "EVIDENCE_INVALID" });
    await expect(readQuarantineEvidence(reference, { ...scope, entityId: randomUUID() }, storage)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("rejects an overwritten quarantine object instead of reading its replacement", async () => {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: evidenceKey, Body: Buffer.from("Replaced file"), ContentType: "image/png" }));
    await expect(readQuarantineEvidence({ ...scope, documentId, declaration, etag: evidenceETag }, scope, { client, bucket })).rejects.toMatchObject({ code: "EVIDENCE_CHANGED" });
  });
  it("accepts the exact signed private PUT and rejects reuse or GET of its capability", async () => {
    const grant = await signQuarantineUpload(scope, uploadIds[0], declaration, { client, bucket }, new Date());
    expect((await fetch(grant.url, { method: "PUT", headers: grant.headers, body: png })).status).toBe(200);
    expect((await fetch(grant.url, { method: "PUT", headers: grant.headers, body: png })).status).toBe(412);
    expect((await fetch(grant.url)).status).toBe(403);
    const stored = await client.send(new GetObjectCommand({ Bucket: bucket, Key: quarantineKey(scope, uploadIds[0]) })); expect(Buffer.from(await stored.Body!.transformToByteArray()).equals(png)).toBe(true);
  });
  it("rejects changed MIME, length, checksum and expired private upload grants", async () => {
    const grant = await signQuarantineUpload(scope, uploadIds[1], declaration, { client, bucket }, new Date());
    expect((await fetch(grant.url, { method: "PUT", headers: { ...grant.headers, "content-type": "text/html" }, body: png })).status).toBe(403);
    const wrong = Buffer.from(png); wrong[10] ^= 1;
    expect((await fetch(grant.url, { method: "PUT", headers: grant.headers, body: wrong })).status).toBe(400);
    expect((await fetch(grant.url, { method: "PUT", headers: { ...grant.headers, "content-length": String(png.length + 1) }, body: Buffer.concat([png, Buffer.from([0])]) })).status).toBe(403);
    const expired = await signQuarantineUpload(scope, uploadIds[2], declaration, { client, bucket }, new Date(Date.now() - 600000));
    expect((await fetch(expired.url, { method: "PUT", headers: expired.headers, body: png })).status).toBe(403);
  });
});
