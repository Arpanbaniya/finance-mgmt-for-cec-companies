import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { EvidenceDeclaration, type EvidenceFile } from "@/domain/evidence";
import { quarantineKey } from "./quarantine-reader";
/** Internal signer. Its caller must authorize the current owner and persist
 * the immutable request first. A PUT capability cannot release/read evidence.
 */
export async function signQuarantineUpload(scope: { organizationId: string; entityId: string }, documentId: string, input: EvidenceFile, storage: { client: S3Client; bucket: string }, issuedAt: Date) {
  const declaration = EvidenceDeclaration.parse(input), checksum = Buffer.from(declaration.sha256, "hex").toString("base64");
  const signingDate = new Date(Math.floor(issuedAt.getTime() / 1000) * 1000);
  const headers = { "content-type": declaration.contentType, "content-length": String(declaration.sizeBytes), "if-none-match": "*" as const, "x-amz-checksum-sha256": checksum };
  const url = await getSignedUrl(storage.client, new PutObjectCommand({ Bucket: storage.bucket, Key: quarantineKey(scope, documentId), ContentType: declaration.contentType,
    ContentLength: declaration.sizeBytes, IfNoneMatch: "*", ChecksumSHA256: checksum }), { expiresIn: 300, signingDate,
    signableHeaders: new Set(["content-type", "content-length", "if-none-match"]), unhoistableHeaders: new Set(["x-amz-checksum-sha256"]) });
  return { method: "PUT" as const, url, headers, expiresAt: new Date(signingDate.getTime() + 300000).toISOString() };
}
