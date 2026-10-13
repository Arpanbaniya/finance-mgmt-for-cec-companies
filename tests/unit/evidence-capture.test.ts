import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { type S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { expect, it, vi } from "vitest";
import { captureQuarantineEvidence } from "@/features/documents/capture";
const scope = { organizationId: randomUUID(), entityId: randomUUID() }, id = randomUUID();
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=", "base64");
const declaration = { filename: "fixture.png", contentType: "image/png", sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
const head = { ContentType: "image/png", ContentLength: bytes.length, ETag: '"snapshot"', VersionId: "object-version-1" };
function fixture(metadata: object = head, content: object = {}) {
  const send = vi.fn().mockResolvedValueOnce(metadata).mockResolvedValueOnce({ ...head, Body: Readable.from([bytes]), ...content });
  return { client: { send } as unknown as S3Client, bucket: "test-bucket", send };
}
it("pins provider HEAD identity in bounded conditional GET and calculates from actual bytes", async () => {
  const store = fixture(), result = await captureQuarantineEvidence(scope, id, declaration, store);
  expect(result).toEqual({ size: bytes.length, sha256: declaration.sha256, etag: head.ETag, versionId: head.VersionId });
  expect(store.send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand); expect(store.send.mock.calls[1][0]).toBeInstanceOf(GetObjectCommand);
  expect(store.send.mock.calls[1][0].input).toMatchObject({ Bucket: store.bucket, Key: `quarantine/${scope.organizationId}/${scope.entityId}/${id}`, IfMatch: head.ETag, VersionId: head.VersionId });
  expect(store.send.mock.calls[0][1].abortSignal).toBe(store.send.mock.calls[1][1].abortSignal);
});
it("supports a conditional snapshot without inventing provider versioning", async () => {
  const store = fixture({ ...head, VersionId: undefined }, { VersionId: undefined });
  expect(await captureQuarantineEvidence(scope, id, declaration, store)).toMatchObject({ versionId: null });
});
it.each([{ ContentLength: bytes.length + 1 }, { ContentType: "text/html" }, { ContentEncoding: "gzip" }, { DeleteMarker: true }])("rejects invalid HEAD metadata before downloading: %j", async patch => {
  const store = fixture({ ...head, ...patch });
  await expect(captureQuarantineEvidence(scope, id, declaration, store)).rejects.toMatchObject({ code: "EVIDENCE_INVALID" }); expect(store.send).toHaveBeenCalledTimes(1);
});
it("missing ETag cannot substitute for independently verified snapshot identity", async () => {
  const store = fixture({ ...head, ETag: undefined }); await expect(captureQuarantineEvidence(scope, id, declaration, store)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" }); expect(store.send).toHaveBeenCalledTimes(1);
});
it("detects a HEAD/GET snapshot change and destroys the content stream", async () => {
  const stream = Readable.from([bytes]), store = fixture(head, { ETag: '"changed"', Body: stream });
  await expect(captureQuarantineEvidence(scope, id, declaration, store)).rejects.toMatchObject({ code: "EVIDENCE_CHANGED" }); expect(stream.destroyed).toBe(true);
});
it.each([403, 404, 500])("redacts provider HEAD failure %i", async status => {
  const send = vi.fn().mockRejectedValue({ $metadata: { httpStatusCode: status }, message: "PRIVATE PROVIDER SECRET" });
  await expect(captureQuarantineEvidence(scope, id, declaration, { client: { send } as unknown as S3Client, bucket: "test-bucket" })).rejects.toMatchObject({ code: status === 500 ? "STORAGE_UNAVAILABLE" : "NOT_FOUND", message: status === 500 ? "Private evidence storage is temporarily unavailable." : "Evidence is unavailable." });
});
