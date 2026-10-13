import { HeadObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { EvidenceDeclaration } from "@/domain/evidence";
import { DomainError } from "@/domain/errors";
import { quarantineKey, QuarantineReference, readQuarantineEvidence } from "./quarantine-reader";

/** Trusted service adapter: authorize the current member and rule owner first.
 * HEAD discovers a provider snapshot, not a content hash or scan verdict.
 * The conditional bounded GET independently checks the actual content.
 */
export async function captureQuarantineEvidence(scope: { organizationId: string; entityId: string }, documentId: string,
  declarationInput: unknown, storage: { client: S3Client; bucket: string }) {
  const declaration = EvidenceDeclaration.parse(declarationInput), key = quarantineKey(scope, documentId), signal = AbortSignal.timeout(15000);
  try {
    const head = await storage.client.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: key }), { abortSignal: signal });
    if (head.DeleteMarker || head.ContentLength !== declaration.sizeBytes || head.ContentType !== declaration.contentType ||
      (head.ContentEncoding && head.ContentEncoding !== "identity")) throw new DomainError("EVIDENCE_INVALID", "Stored evidence headers differ from the declaration.");
    const reference = QuarantineReference.safeParse({ ...scope, documentId, declaration, etag: head.ETag, versionId: head.VersionId });
    if (!reference.success) throw new DomainError("STORAGE_UNAVAILABLE", "Evidence snapshot identity is unavailable.", 503);
    const content = await readQuarantineEvidence(reference.data, scope, storage, signal);
    return Object.freeze({ size: content.declaration.sizeBytes, sha256: content.declaration.sha256, etag: content.etag, versionId: content.versionId ?? null });
  } catch (error) {
    if (error instanceof DomainError) throw error;
    const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (status === 403 || status === 404) throw new DomainError("NOT_FOUND", "Evidence is unavailable.", 404);
    throw new DomainError("STORAGE_UNAVAILABLE", "Private evidence storage is temporarily unavailable.", 503);
  }
}
