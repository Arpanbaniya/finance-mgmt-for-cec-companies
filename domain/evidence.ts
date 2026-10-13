import { createHash } from "node:crypto";
import { z } from "zod";
import { DomainError } from "./errors";

export const maximumEvidenceBytes = 10 * 1024 * 1024;
// A filename is display metadata, never an object key or filesystem path.
export const EvidenceDeclaration = z.strictObject({
  filename: z.string().trim().min(1).max(200).refine(value => !/[\x00-\x1f\x7f\\/:"<>|?*]/.test(value) && !value.startsWith(".") && !value.endsWith("."), "Use a plain filename."),
  contentType: z.enum(["image/jpeg", "image/png", "application/pdf"]),
  sizeBytes: z.number().int().positive().max(maximumEvidenceBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).superRefine((value, ctx) => {
  const extension = value.filename.split(".").at(-1)?.toLowerCase();
  const allowed = { "image/jpeg": ["jpg", "jpeg"], "image/png": ["png"], "application/pdf": ["pdf"] };
  if (!extension || !allowed[value.contentType].includes(extension)) ctx.addIssue({ code: "custom", path: ["filename"], message: "Filename extension must match the evidence type." });
});
export type EvidenceFile = z.input<typeof EvidenceDeclaration>;
function invalid(message: string): never { throw new DomainError("EVIDENCE_INVALID", message); }

/** Content identification, not a full decoder, sanitizer or malware scanner. */
export function validateEvidenceContent(input: unknown, bytes: Uint8Array) {
  const declaration = EvidenceDeclaration.parse(input);
  if (bytes.byteLength !== declaration.sizeBytes || bytes.byteLength > maximumEvidenceBytes) invalid("Actual evidence size differs from the declaration.");
  const body = Buffer.from(bytes), prefix = body.subarray(0, 8), suffix = body.subarray(-12);
  let identified: EvidenceFile["contentType"] | undefined;
  if (body.length >= 20 && prefix.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && suffix.equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))) identified = "image/png";
  else if (body.length >= 5 && body[0] === 255 && body[1] === 216 && body[2] === 255 && body.at(-2) === 255 && body.at(-1) === 217) identified = "image/jpeg";
  else if (/^%PDF-(?:1\.[0-7]|2\.0)/.test(prefix.toString("ascii")) && /(?:^|[\r\n])%%EOF[\x09\x0a\x0c\x0d\x20]*$/.test(body.subarray(-1024).toString("latin1"))) identified = "application/pdf";
  if (!identified || identified !== declaration.contentType) invalid("Actual evidence content does not match its declared type.");
  if (createHash("sha256").update(body).digest("hex") !== declaration.sha256) invalid("Actual evidence fingerprint differs from the declaration.");
  return Object.freeze({ ...declaration, identifiedContentType: identified });
}
