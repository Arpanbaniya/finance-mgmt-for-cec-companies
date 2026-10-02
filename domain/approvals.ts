import { createHash } from "node:crypto";
import { ApprovalPolicyCreate, type AggregateType, type PolicyDefinition } from "./approval-policy";
import { businessDate, containsDate } from "./dates";
import { decimal, money } from "./money";
import { DomainError } from "./errors";

export type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };
export function canonicalJSON(value: JsonValue): string {
  if (value === undefined || !["object", "string", "number", "boolean"].includes(typeof value)) throw new DomainError("INVALID_CONTENT", "Content must be JSON.");
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new DomainError("INVALID_CONTENT", "Content must be finite JSON.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new DomainError("INVALID_CONTENT", "Content must be plain JSON.");
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(",")}}`;
}
export function contentHash(value: JsonValue): string { return createHash("sha256").update(canonicalJSON(value)).digest("hex"); }
type Policy = { id: string; version: number; status: "active"; definition: PolicyDefinition };
type Source = { organizationId: string; entityId: string; aggregateId: string; aggregateType: AggregateType; creatorId: string; version: number; amount: string; currency: "NPR"; businessDate: string; content: JsonValue };
export type ApprovalSnapshot = { source: Source; policy: Policy; threshold: PolicyDefinition["thresholds"][number]; hash: string };
export type ApprovalDecision = { actorId: string; snapshotHash: string; sourceVersion: number };
export function freezeSubmission(source: Source, policy: Policy): ApprovalSnapshot {
  const definition = ApprovalPolicyCreate.parse(policy.definition);
  businessDate(source.businessDate);
  if (!Number.isSafeInteger(source.version) || source.version < 1 || policy.status !== "active" || policy.version < 1 || !definition.aggregateTypes.includes(source.aggregateType)
    || source.currency !== definition.currency || !containsDate(definition.effectiveFrom, definition.effectiveTo ?? null, source.businessDate)) throw new DomainError("NO_APPROVAL_POLICY", "An active applicable policy is required.");
  const amount = decimal(source.amount);
  if (amount.isNegative()) throw new DomainError("INVALID_AMOUNT", "Approval amount must be nonnegative.");
  const threshold = definition.thresholds.find(row => amount.greaterThanOrEqualTo(decimal(row.minInclusive)) && (row.maxExclusive === undefined || amount.lessThan(decimal(row.maxExclusive))));
  if (!threshold) throw new DomainError("NO_APPROVAL_POLICY", "Policy does not cover this amount.");
  const frozen = JSON.parse(canonicalJSON({ source: { ...source, amount: money(amount) }, policy: { ...policy, definition }, threshold })) as Omit<ApprovalSnapshot, "hash">;
  return { ...frozen, hash: contentHash(frozen as unknown as JsonValue) };
}
export function decideApproval(snapshot: ApprovalSnapshot, current: Source, actorId: string, permissions: ReadonlySet<string>, previous: readonly ApprovalDecision[]) {
  const checked = freezeSubmission(current, snapshot.policy);
  const stored = contentHash({ source: snapshot.source, policy: snapshot.policy, threshold: snapshot.threshold } as unknown as JsonValue);
  if (stored !== snapshot.hash || checked.hash !== snapshot.hash) throw new DomainError("APPROVAL_INVALIDATED", "Content or protected version changed; submit again.", 409);
  if (actorId === current.creatorId) throw new DomainError("SELF_APPROVAL", "The creator cannot approve this protected version.", 403);
  if (!permissions.has(snapshot.threshold.requiredPermission)) throw new DomainError("FORBIDDEN", "The required approval permission is missing.", 403);
  if (previous.some(d => d.snapshotHash !== snapshot.hash || d.sourceVersion !== current.version || d.actorId === current.creatorId) || new Set(previous.map(d => d.actorId)).size !== previous.length) throw new DomainError("INVALID_DECISIONS", "Only distinct independent decisions for this snapshot count.", 409);
  if (previous.some(d => d.actorId === actorId)) throw new DomainError("DUPLICATE_APPROVER", "This approver already decided on this snapshot.", 409);
  const decisions = [...previous, { actorId, snapshotHash: snapshot.hash, sourceVersion: current.version }];
  return { decisions, approved: decisions.length >= snapshot.threshold.numberOfDistinctApprovers };
}
