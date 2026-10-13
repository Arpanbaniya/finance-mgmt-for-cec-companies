import { z } from "zod";
import { EvidenceDeclaration } from "@/domain/evidence";
export const DocumentUploadRequest = EvidenceDeclaration.safeExtend({ sensitivity: z.literal("internal"), ownerType: z.literal("rule_version"), ownerId: z.uuid() });
export const PendingDocument = z.strictObject({ id: z.uuid(), organizationId: z.uuid(), entityId: z.uuid(), ownerType: z.literal("rule_version"), ownerId: z.uuid(),
  ownerAggregateType: z.literal("rule_version"), ownerAggregateId: z.uuid(), storageKey: z.string(), originalName: z.string(), contentType: z.enum(["image/jpeg", "image/png", "application/pdf"]),
  size: z.null(), hash: z.null(), retentionClass: z.literal("unconfigured"), deletionHold: z.literal(false),
  declaration: EvidenceDeclaration, sensitivity: z.literal("internal"), status: z.literal("pending_upload"), scanState: z.literal("quarantined"),
  actualHash: z.null(), capturedAt: z.null(), uploadedBy: z.null(), requestedBy: z.string(), createdAt: z.iso.datetime(), version: z.literal(1), demoOnly: z.boolean(),
  sourceReferences: z.array(z.strictObject({ title: z.string(), url: z.url(), section: z.string(), sha256: z.string() })).min(1).max(10) });
export const UploadGrant = z.strictObject({ documentId: z.uuid(), method: z.literal("PUT"), url: z.url(), expiresAt: z.iso.datetime(),
  headers: z.strictObject({ "content-type": z.enum(["image/jpeg", "image/png", "application/pdf"]), "content-length": z.string().regex(/^[1-9][0-9]*$/), "if-none-match": z.literal("*"), "x-amz-checksum-sha256": z.string() }), document: PendingDocument });
export const UploadComplete = z.strictObject({ documentId: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export const CapturedDocument = PendingDocument.extend({ status: z.literal("captured_quarantined"), version: z.literal(2),
  size: z.number().int().min(1).max(10485760), hash: z.string().regex(/^[a-f0-9]{64}$/), actualHash: z.string().regex(/^[a-f0-9]{64}$/),
  capturedAt: z.iso.datetime(), uploadedBy: z.string(), capturedBy: z.string() });
export const DocumentDTO = z.discriminatedUnion("status", [PendingDocument, CapturedDocument]);
