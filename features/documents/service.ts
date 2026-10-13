import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { contentHash } from "@/domain/approvals";
import { EvidenceDeclaration } from "@/domain/evidence";
import { withScope } from "@/features/identity/scope";
import { replay, remember } from "@/features/platform/idempotency";
import { audit } from "@/features/platform/service";
import { storageClient, storageConfig } from "./storage-config";
import { signQuarantineUpload } from "./upload-grant";
import { quarantineKey } from "./quarantine-reader";
import { DocumentUploadRequest, PendingDocument, UploadGrant, UploadComplete, CapturedDocument } from "./contracts";
import { captureQuarantineEvidence } from "./capture";
function dto(row: Record<string, unknown>) {
  const declaration = EvidenceDeclaration.parse(row.declaration);
  return PendingDocument.parse({ id: row.id, organizationId: row.organization_id, entityId: row.legal_entity_id, ownerType: "rule_version", ownerId: row.rule_id,
    ownerAggregateType: "rule_version", ownerAggregateId: row.rule_id, storageKey: quarantineKey({ organizationId: String(row.organization_id), entityId: String(row.legal_entity_id) }, String(row.id)),
    originalName: declaration.filename, contentType: declaration.contentType, size: null, hash: null, retentionClass: "unconfigured", deletionHold: false,
    declaration, sourceReferences: row.source_references, demoOnly: row.demo_only, sensitivity: row.sensitivity, status: row.status, scanState: row.scan_state,
    actualHash: null, capturedAt: null, uploadedBy: null, requestedBy: row.created_by, createdAt: (row.created_at as Date).toISOString(), version: row.version });
}
export async function getPendingDocument(user: string, org: string, entity: string, id: string) {
  return withScope(user, org, entity, "documents.read", async client => {
    const rows = await client.query(documentQuery, [org, entity, z.uuid().parse(id)]);
    if (!rows.rowCount) throw new DomainError("NOT_FOUND", "Evidence document is unavailable.", 404);
    return documentDTO(rows.rows[0]);
  });
}
const documentQuery = `SELECT r.*,c.actual_size,c.actual_hash,c.uploaded_by,c.captured_by,c.captured_at FROM rule_evidence_requests r
  LEFT JOIN rule_evidence_captures c ON c.organization_id=r.organization_id AND c.legal_entity_id=r.legal_entity_id AND c.document_id=r.id
  WHERE r.organization_id=$1 AND r.legal_entity_id=$2 AND r.id=$3`;
function documentDTO(row: Record<string, unknown>) {
  const pending = dto(row);
  return row.captured_at ? CapturedDocument.parse({ ...pending, status: "captured_quarantined", version: 2, size: row.actual_size, hash: row.actual_hash,
    actualHash: row.actual_hash, uploadedBy: row.uploaded_by, capturedBy: row.captured_by, capturedAt: (row.captured_at as Date).toISOString() }) : pending;
}
export async function completeRuleEvidenceUpload(user: string, org: string, entity: string, id: string, input: z.input<typeof UploadComplete>,
  version: number, key: string, requestId: string) {
  const command = UploadComplete.parse(input), documentId = z.uuid().parse(id);
  if (command.documentId !== documentId) throw new DomainError("DOCUMENT_MISMATCH", "Document IDs must match.");
  if (!Number.isSafeInteger(version) || version < 1) throw new DomainError("INVALID_VERSION", "Version is out of range.", 400);
  return withScope(user, org, entity, "documents.create", async client => {
    await client.query("SELECT app_security.lock_policy_scope($1,$2)", [org, entity]);
    const access = await client.query("SELECT app_security.can_manage_accounts($1) AND app_security.finance_setup_scope($1,$2) AS allowed", [org, entity]);
    if (!access.rows[0].allowed) throw new DomainError("FORBIDDEN", "Current finance manager authority is required.", 403);
    const rows = await client.query(documentQuery, [org, entity, documentId]);
    if (!rows.rowCount) throw new DomainError("NOT_FOUND", "Evidence document is unavailable.", 404);
    const document = documentDTO(rows.rows[0]);
    const owner = await client.query("SELECT id FROM rule_versions WHERE organization_id=$1 AND legal_entity_id=$2 AND id=$3", [org, entity, document.ownerId]);
    if (!owner.rowCount) throw new DomainError("NOT_FOUND", "Evidence owner is unavailable.", 404);
    if (document.demoOnly) {
      const company = await client.query("SELECT policy_status,reporting_profile FROM legal_entities WHERE organization_id=$1 AND id=$2", [org, entity]);
      if (company.rows[0]?.policy_status !== "demo" || company.rows[0]?.reporting_profile !== "demo_accrual") throw new DomainError("DEMO_RULE_FORBIDDEN", "Synthetic evidence requires a demo company.", 409);
    }
    const operation = `document.complete:${entity}`, hash = contentHash({ id: documentId, version, command }), prior = await replay(client, org, user, operation, key, hash);
    if (prior) return CapturedDocument.parse(prior);
    if (version !== document.version) throw new DomainError("VERSION_CONFLICT", "Reload the current evidence document.", 412);
    if (document.status !== "pending_upload") throw new DomainError("INVALID_STATE", "Evidence has already been captured.", 409);
    if (command.sha256 !== document.declaration.sha256) throw new DomainError("SOURCE_MISMATCH", "Completion must match the declared source hash.");
    let config: ReturnType<typeof storageConfig>;
    try { config = storageConfig(); } catch { throw new DomainError("STORAGE_UNAVAILABLE", "Private evidence storage is not configured.", 503); }
    const storage = storageClient();
    try {
      const captured = await captureQuarantineEvidence({ organizationId: org, entityId: entity }, documentId, document.declaration, { client: storage, bucket: config.S3_BUCKET });
      await client.query(`INSERT INTO rule_evidence_captures(document_id,organization_id,legal_entity_id,actual_size,actual_hash,provider_etag,provider_version_id,storage_bucket,storage_endpoint,uploaded_by,captured_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [documentId, org, entity, captured.size, captured.sha256, captured.etag, captured.versionId, config.S3_BUCKET, new URL(config.S3_ENDPOINT).origin, document.requestedBy, user]);
      const response = CapturedDocument.parse(documentDTO((await client.query(documentQuery, [org, entity, documentId])).rows[0]));
      await audit(client, org, user, "document.complete", documentId, requestId, entity);
      await remember(client, org, user, operation, key, hash, documentId, response);
      return response;
    } finally { storage.destroy(); }
  });
}
export async function requestRuleEvidenceUpload(user: string, org: string, entity: string, input: z.input<typeof DocumentUploadRequest>, key: string, requestId: string) {
  const command = DocumentUploadRequest.parse(input), declaration = EvidenceDeclaration.parse(Object.fromEntries(Object.keys(EvidenceDeclaration.shape).map(name => [name, command[name as keyof typeof command]])));
  return withScope(user, org, entity, "documents.create", async client => {
    await client.query("SELECT app_security.lock_policy_scope($1,$2)", [org, entity]);
    const access = await client.query("SELECT app_security.can_manage_accounts($1) AND app_security.finance_setup_scope($1,$2) AS allowed", [org, entity]);
    if (!access.rows[0].allowed) throw new DomainError("FORBIDDEN", "Current finance manager authority is required.", 403);
    const owner = await client.query("SELECT definition FROM rule_versions WHERE organization_id=$1 AND legal_entity_id=$2 AND id=$3", [org, entity, command.ownerId]);
    if (!owner.rowCount) throw new DomainError("NOT_FOUND", "Evidence owner is unavailable.", 404);
    if (owner.rows[0].definition.demoOnly) {
      const company = await client.query("SELECT policy_status,reporting_profile FROM legal_entities WHERE organization_id=$1 AND id=$2", [org, entity]);
      if (company.rows[0]?.policy_status !== "demo" || company.rows[0]?.reporting_profile !== "demo_accrual") throw new DomainError("DEMO_RULE_FORBIDDEN", "Synthetic evidence requires a demo company.", 409);
    }
    const operation = `document.upload-request:${entity}`, hash = contentHash(command), prior = await replay(client, org, user, operation, key, hash);
    if (prior) return UploadGrant.parse(prior); // Original expiry is retained, never renewed by replay.
    const refs = (owner.rows[0].definition.sourceReferences as { sha256: string; title: string; url: string }[]).filter(ref => ref.sha256 === command.sha256);
    if (!refs.length || new Set(refs.map(ref => JSON.stringify([ref.title, ref.url]))).size !== 1) throw new DomainError("SOURCE_MISMATCH", "The file must identify one declared rule source.");
    let config: ReturnType<typeof storageConfig>;
    try { config = storageConfig(); } catch { throw new DomainError("STORAGE_UNAVAILABLE", "Private evidence storage is not configured.", 503); }
    const rows = await client.query("INSERT INTO rule_evidence_requests(id,organization_id,legal_entity_id,rule_id,declaration,source_references,demo_only,created_by) VALUES($1,$2,$3,$4,$5,'[]',false,$6) RETURNING *", [randomUUID(), org, entity, command.ownerId, JSON.stringify(declaration), user]);
    const document = dto(rows.rows[0]), storage = storageClient();
    try {
      let signed: Awaited<ReturnType<typeof signQuarantineUpload>>;
      try { signed = await signQuarantineUpload({ organizationId: org, entityId: entity }, document.id, declaration, { client: storage, bucket: config.S3_BUCKET }, rows.rows[0].created_at); }
      catch { throw new DomainError("STORAGE_UNAVAILABLE", "Private evidence upload signing is unavailable.", 503); }
      const response = UploadGrant.parse({ ...signed, documentId: document.id, document });
      await audit(client, org, user, "document.upload-request", document.id, requestId, entity);
      await remember(client, org, user, operation, key, hash, document.id, response); return response;
    } finally { storage.destroy(); }
  });
}
