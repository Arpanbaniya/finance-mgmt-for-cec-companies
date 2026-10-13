import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { S3Client } from "@aws-sdk/client-s3";
import { expect, it, vi } from "vitest";
import { EvidenceDeclaration, maximumEvidenceBytes, validateEvidenceContent } from "@/domain/evidence";
import { readQuarantineEvidence, quarantineKey } from "@/features/documents/quarantine-reader";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=", "base64");
const declaration = (bytes = png) => ({ filename: "Synthetic-source.PNG", contentType: "image/png" as const, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
const scope = { organizationId: randomUUID(), entityId: randomUUID() }, reference = { ...scope, documentId: randomUUID(), declaration: declaration(), etag: '"retained-etag"' };
function storage(patch: object = {}, chunks: Uint8Array[] = [png]) {
  const body = Readable.from(chunks), send = vi.fn().mockResolvedValue({ ETag: reference.etag, ContentType: "image/png", ContentLength: png.length, Body: body, ...patch });
  return { client: { send } as unknown as S3Client, bucket: "private-evidence", send, body };
}
it("validates actual PNG content and an immutable fingerprint receipt", () => {
  const result = validateEvidenceContent(declaration(), png); expect(result.identifiedContentType).toBe("image/png"); expect(Object.isFrozen(result)).toBe(true); expect(result).not.toHaveProperty("scanState");
});
it("identifies JPEG and PDF envelopes without claiming a decoder or clean scan", () => {
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 255, 217]), pdf = Buffer.from("%PDF-1.7\nSynthetic fixture; not a parsed PDF\n%%EOF\n");
  for (const [body, filename, contentType] of [[jpeg, "demo.jpeg", "image/jpeg"], [pdf, "demo.pdf", "application/pdf"]] as const) expect(validateEvidenceContent({ ...declaration(body), filename, contentType }, body).identifiedContentType).toBe(contentType);
});
it("rejects content spoofing, truncation, appended payloads and wrong fingerprints", () => {
  for (const bytes of [Buffer.from("<html>pretend PNG</html>"), png.subarray(0, -1), Buffer.concat([png, Buffer.from("<script>bad</script>")])]) expect(() => validateEvidenceContent(declaration(bytes), bytes)).toThrow("content");
  expect(() => validateEvidenceContent({ ...declaration(), sha256: "a".repeat(64) }, png)).toThrow("fingerprint");
  expect(() => validateEvidenceContent({ ...declaration(), sizeBytes: png.length - 1 }, png)).toThrow("size");
  expect(() => validateEvidenceContent({ ...declaration(), filename: "wrong.pdf", contentType: "application/pdf" }, png)).toThrow("content");
});
it("rejects unsupported types, path/header filenames, bad size/hash and client scan fields", () => {
  for (const patch of [{ contentType: "text/html" }, { filename: "source.svg" }, { filename: "source.html" }, { filename: "../source.png" }, { filename: "C:\\source.png" }, { filename: "source\r\n.png" }, { filename: 'source".png' }, { sizeBytes: 0 }, { sizeBytes: maximumEvidenceBytes + 1 }, { sizeBytes: 1.5 }, { sha256: "not-a-hash" }, { scanState: "clean" }]) expect(EvidenceDeclaration.safeParse({ ...declaration(), ...patch }).success).toBe(false);
  expect(EvidenceDeclaration.safeParse({ ...declaration(), filename: "स्रोत.png", sizeBytes: maximumEvidenceBytes }).success).toBe(true);
});
it("derives random-ID scoped object paths instead of accepting a filename/path", () => {
  expect(quarantineKey(scope, reference.documentId)).toBe(`quarantine/${scope.organizationId}/${scope.entityId}/${reference.documentId}`);
  expect(() => quarantineKey(scope, "../other-company")).toThrow();
});
it("reads bounded chunks from the exact provider snapshot without releasing evidence", async () => {
  const client = storage({}, [png.subarray(0, 3), png.subarray(3)]), result = await readQuarantineEvidence(reference, scope, client);
  expect(result.bytes.equals(png)).toBe(true); expect(result).not.toHaveProperty("scanState"); expect(result).not.toHaveProperty("retentionHeld"); expect(client.body.destroyed).toBe(true);
  expect(client.send.mock.calls[0][0].input).toMatchObject({ Key: quarantineKey(scope, reference.documentId), IfMatch: reference.etag });
});
it("rejects cross-company and arbitrary-key input before contacting storage", async () => {
  const client = storage(); await expect(readQuarantineEvidence(reference, { ...scope, entityId: randomUUID() }, client)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(readQuarantineEvidence({ ...reference, storageKey: "another/key" } as typeof reference, scope, client)).rejects.toThrow(); expect(client.send).not.toHaveBeenCalled();
});
it("rejects mismatched response versions, sizes, MIME and encoded/range responses", async () => {
  for (const patch of [{ ETag: '"changed"' }, { VersionId: "other" }, { ContentLength: png.length + 1 }, { ContentType: "text/html" }, { ContentRange: "bytes 0-67/68" }, { ContentEncoding: "gzip" }]) {
    const client = storage({ VersionId: "version-one", ...patch }); await expect(readQuarantineEvidence({ ...reference, versionId: "version-one" }, scope, client)).rejects.toThrow(); expect(client.body.destroyed).toBe(true);
  }
  const client = storage({ VersionId: "version-one" }); expect((await readQuarantineEvidence({ ...reference, versionId: "version-one" }, scope, client)).versionId).toBe("version-one");
});
it("bounds bytes independently of claimed Content-Length and closes rejected streams", async () => {
  for (const chunks of [[png.subarray(0, -1)], [png, Buffer.from([0])]]) { const client = storage({}, chunks); await expect(readQuarantineEvidence(reference, scope, client)).rejects.toMatchObject({ code: "EVIDENCE_INVALID" }); expect(client.body.destroyed).toBe(true); }
});
it("redacts storage errors and treats replaced/missing snapshots as unavailable", async () => {
  for (const [status, code] of [[412, "EVIDENCE_CHANGED"], [403, "NOT_FOUND"], [404, "NOT_FOUND"], [500, "STORAGE_UNAVAILABLE"]]) {
    const client = storage(); client.send.mockRejectedValue({ $metadata: { httpStatusCode: status }, message: "private-bucket-secret" });
    await expect(readQuarantineEvidence(reference, scope, client)).rejects.toMatchObject({ code });
    await expect(readQuarantineEvidence(reference, scope, client)).rejects.not.toThrow("private-bucket-secret");
  }
});
it("rejects absent content and redacts a failure midway through a stream", async () => {
  await expect(readQuarantineEvidence(reference, scope, storage({ Body: undefined }))).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  const body = Readable.from((async function* () { yield png.subarray(0, 10); throw new Error("private-provider-detail"); })());
  const client = storage({ Body: body });
  await expect(readQuarantineEvidence(reference, scope, client)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", message: "Private evidence storage is temporarily unavailable." }); expect(body.destroyed).toBe(true);
});
it("aborts a stalled read at the configured deadline and closes the stream", async () => {
  const deadline = new AbortController(), timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal), body = new Readable({ read() {} });
  try {
    const result = readQuarantineEvidence(reference, scope, storage({ Body: body }));
    await new Promise(resolve => setTimeout(resolve, 5)); deadline.abort();
    await expect(result).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" }); expect(body.destroyed).toBe(true); expect(timeout).toHaveBeenCalledWith(15000);
  } finally { timeout.mockRestore(); body.destroy(); }
});
