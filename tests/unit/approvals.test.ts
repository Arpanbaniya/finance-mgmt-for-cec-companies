import { expect, it } from "vitest";
import { ApprovalPolicyCreate } from "@/domain/approval-policy";
import { contentHash, freezeSubmission, decideApproval } from "@/domain/approvals";
const definition = ApprovalPolicyCreate.parse({ name: "Journal checks", effectiveFrom: "2026-01-01", effectiveTo: "2027-01-01", aggregateTypes: ["journal"], currency: "NPR", makerChecker: true,
  thresholds: [{ minInclusive: "0.00", maxExclusive: "1000.00", requiredPermission: "journals.approve", numberOfDistinctApprovers: 1 }, { minInclusive: "1000.00", requiredPermission: "journals.approve", numberOfDistinctApprovers: 2 }] });
const policy = { id: "policy-a", version: 2, status: "active" as const, definition };
const source = { organizationId: "org-a", entityId: "entity-a", aggregateId: "journal-a", aggregateType: "journal" as const, creatorId: "maker", version: 3, amount: "1000.00", currency: "NPR" as const, businessDate: "2026-10-02", content: { lines: [{ debit: "1000.00", credit: "0.00" }, { debit: "0.00", credit: "1000.00" }] } };
const grants = new Set(["journals.approve"]);
it("canonical hashes ignore object key order but preserve line order and scope", () => {
  expect(contentHash({ z: "1.00", a: [1, 2] })).toBe(contentHash({ a: [1, 2], z: "1.00" }));
  expect(contentHash({ a: [1, 2] })).not.toBe(contentHash({ a: [2, 1] }));
  expect(freezeSubmission(source, policy).hash).not.toBe(freezeSubmission({ ...source, entityId: "entity-b" }, policy).hash);
  expect(() => contentHash({ bad: Infinity })).toThrow();
});
it("threshold boundaries are exact and unbounded, with date end excluded", () => {
  expect(freezeSubmission({ ...source, amount: "999.99" }, policy).threshold.numberOfDistinctApprovers).toBe(1);
  expect(freezeSubmission(source, policy).threshold.numberOfDistinctApprovers).toBe(2);
  expect(freezeSubmission({ ...source, amount: "999999999999999999.99" }, policy).threshold.numberOfDistinctApprovers).toBe(2);
  expect(() => freezeSubmission({ ...source, businessDate: "2027-01-01" }, policy)).toThrow();
  expect(() => freezeSubmission({ ...source, amount: "-1.00" }, policy)).toThrow();
});
it("distinct authorized checkers exclude maker and duplicates", () => {
  const snapshot = freezeSubmission(source, policy);
  expect(() => decideApproval(snapshot, source, "maker", grants, [])).toThrow(/creator/);
  expect(() => decideApproval(snapshot, source, "checker-a", new Set(), [])).toThrow(/permission/);
  const first = decideApproval(snapshot, source, "checker-a", grants, []); expect(first.approved).toBe(false);
  expect(() => decideApproval(snapshot, source, "checker-a", grants, first.decisions)).toThrow(/already/);
  expect(decideApproval(snapshot, source, "checker-b", grants, first.decisions).approved).toBe(true);
});
it("editing protected content, amount, version or identity invalidates approvals", () => {
  const snapshot = freezeSubmission(source, policy);
  for (const changed of [{ ...source, amount: "1001.00" }, { ...source, version: 4 }, { ...source, creatorId: "other" }, { ...source, content: { lines: [] } }]) expect(() => decideApproval(snapshot, changed, "checker", grants, [])).toThrow(/changed/);
  expect(() => decideApproval({ ...snapshot, threshold: { ...snapshot.threshold, numberOfDistinctApprovers: 1 } }, source, "checker", grants, [])).toThrow(/changed/);
});
it("submissions copy policy and source; later caller edits cannot weaken frozen rules", () => {
  const mutablePolicy = structuredClone(policy), mutableSource = structuredClone(source), snapshot = freezeSubmission(mutableSource, mutablePolicy);
  mutablePolicy.definition.thresholds[1].numberOfDistinctApprovers = 1; mutableSource.content.lines[0].debit = "0.00";
  expect(snapshot.threshold.numberOfDistinctApprovers).toBe(2); expect(snapshot.source.content).toEqual(source.content);
  expect(decideApproval(snapshot, source, "checker", grants, []).approved).toBe(false);
});
it("decisions for another protected snapshot or creator never count", () => {
  const snapshot = freezeSubmission(source, policy);
  for (const prior of [[{ actorId: "checker-a", sourceVersion: 2, snapshotHash: snapshot.hash }], [{ actorId: "maker", sourceVersion: 3, snapshotHash: snapshot.hash }]]) expect(() => decideApproval(snapshot, source, "checker-b", grants, prior)).toThrow(/distinct independent/);
});
