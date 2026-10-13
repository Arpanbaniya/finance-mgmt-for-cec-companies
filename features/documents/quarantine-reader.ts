import { Readable } from "node:stream";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { EvidenceDeclaration, validateEvidenceContent } from "@/domain/evidence";
import { DomainError } from "@/domain/errors";

const Scope = z.strictObject({ organizationId: z.uuid(), entityId: z.uuid() });
export const QuarantineReference = z.strictObject({ ...Scope.shape, documentId: z.uuid(), declaration: EvidenceDeclaration,
  // Retained from the provider response by a trusted upload repository, never
  // a client-certified scan result. A provider version is pinned when present.
  etag: z.string().regex(/^"[A-Za-z0-9-]{1,200}"$/), versionId: z.string().min(1).max(1024).optional() });
export function quarantineKey(scopeInput: z.input<typeof Scope>, documentId: string) {
  const scope = Scope.parse(scopeInput);
  return `quarantine/${scope.organizationId}/${scope.entityId}/${z.uuid().parse(documentId)}`;
}
type ReaderStorage = { client: S3Client; bucket: string };
/** Internal byte reader only. The calling application service must authorize
 * current membership AND bound owner access and load this trusted reference.
 * This function neither releases a file nor persists a hold or scan decision.
 */
export async function readQuarantineEvidence(referenceInput: z.input<typeof QuarantineReference>, scopeInput: z.input<typeof Scope>, storage: ReaderStorage) {
  const reference = QuarantineReference.parse(referenceInput), scope = Scope.parse(scopeInput);
  if (reference.organizationId !== scope.organizationId || reference.entityId !== scope.entityId) throw new DomainError("NOT_FOUND", "Evidence is unavailable.", 404);
  const signal = AbortSignal.timeout(15000); let body: Readable | undefined;
  const abort = () => body?.destroy(new Error("Evidence read timed out."));
  try {
    const result = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: quarantineKey(scope, reference.documentId), IfMatch: reference.etag, VersionId: reference.versionId }), { abortSignal: signal });
    if (!(result.Body instanceof Readable)) throw new DomainError("STORAGE_UNAVAILABLE", "Evidence content is unavailable.", 503);
    body = result.Body; signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) throw new DomainError("STORAGE_UNAVAILABLE", "Evidence read timed out.", 503);
    if (result.ETag !== reference.etag || (reference.versionId !== undefined && result.VersionId !== reference.versionId)) throw new DomainError("EVIDENCE_CHANGED", "Stored evidence changed; capture it again.", 409);
    if (result.ContentLength !== reference.declaration.sizeBytes || result.ContentType !== reference.declaration.contentType || result.ContentRange || (result.ContentEncoding && result.ContentEncoding !== "identity")) throw new DomainError("EVIDENCE_INVALID", "Stored evidence headers differ from the declaration.");
    const bytes = Buffer.alloc(reference.declaration.sizeBytes); let offset = 0;
    for await (const chunk of body) {
      if (!(chunk instanceof Uint8Array) || offset + chunk.byteLength > bytes.byteLength) throw new DomainError("EVIDENCE_INVALID", "Actual evidence exceeds its declared size.");
      bytes.set(chunk, offset); offset += chunk.byteLength;
    }
    if (offset !== bytes.byteLength) throw new DomainError("EVIDENCE_INVALID", "Actual evidence is incomplete.");
    const declaration = validateEvidenceContent(reference.declaration, bytes);
    // No clean/demo-fixture label or retention authority is invented here.
    return Object.freeze({ bytes, declaration, etag: reference.etag, versionId: reference.versionId });
  } catch (error) {
    if (error instanceof DomainError) throw error;
    const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (status === 412) throw new DomainError("EVIDENCE_CHANGED", "Stored evidence changed; capture it again.", 409);
    if (status === 404 || status === 403) throw new DomainError("NOT_FOUND", "Evidence is unavailable.", 404);
    throw new DomainError("STORAGE_UNAVAILABLE", "Private evidence storage is temporarily unavailable.", 503);
  } finally { signal.removeEventListener("abort", abort); body?.destroy(); }
}
