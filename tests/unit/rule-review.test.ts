import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import * as taxRules from "@/domain/tax-rules";
import { prepareRuleReview, runTaxRuleTests, resolveTaxRule, RuleVerification, type RuleCandidate } from "@/domain/rule-review";
const organizationId = randomUUID(), entityId = randomUUID(), id = randomUUID(), sourceId = randomUUID(), bytes = new TextEncoder().encode("Synthetic tax fixture A: 10 percent; not Nepal law."), sha256 = createHash("sha256").update(bytes).digest("hex");
const scope = { organizationId, entityId, companyDemo: true, now: "2026-10-13T00:00:00Z" };
const record = { id, organizationId, entityId, version: 1, contentHash: "a".repeat(64), createdBy: "maker", createdAt: "2026-10-12T00:00:00Z", evaluatorVersion: "tax-line-v1", status: "draft" as const,
  policy: { kind: "sales_tax" as const, applicability: { event: "invoice" as const, taxCode: "DEMO_OUTPUT" }, effectiveFrom: "2026-01-01", effectiveTo: "2027-01-01",
    demoOnly: true, definition: { method: "percentage" as const, rate: "10", basis: "exclusive" as const, rounding: "half_up_line" as const, inputCredit: "not_applicable" as const }, sourceReferences: [{ title: "Synthetic fixture", url: "https://example.invalid/fixture", section: "A", sha256 }] } };
const document = { id: sourceId, organizationId, entityId, ruleId: id, title: record.policy.sourceReferences[0].title, url: record.policy.sourceReferences[0].url, sha256, bytes,
  capturedAt: "2026-10-12T01:00:00Z", scanState: "demo_fixture" as const, demoOnly: true, retentionHeld: true };
const command = { sourceDocumentIds: [sourceId], sourceSections: ["A"], verificationNote: "Reviewed synthetic fixture and applicability." };
const actor = { scope, actorId: "reviewer", permissions: new Set(["rules.verify"]) };
const resolution = { ...scope, event: "invoice", kind: "sales_tax", taxCode: "DEMO_OUTPUT", businessDate: "2026-10-13" };
const reviewed = () => prepareRuleReview(record, command, [document], actor);
const candidate = (): RuleCandidate => ({ record: { ...record, status: "active", version: 3 }, review: reviewed(), tests: runTaxRuleTests(record) });
it("prepares an independent immutable review from actual retained bytes without leaking content", () => {
  const result = reviewed(); expect(result).toMatchObject({ verifiedBy: "reviewer", demoOnly: true, sourceVersion: 1 });
  expect(result.documents[0]).not.toHaveProperty("bytes"); expect(Object.isFrozen(result.documents[0])).toBe(true); expect(Object.isFrozen(result.sourceSections)).toBe(true);
});
it("rejects unprivileged, self and out-of-scope reviewers", () => {
  expect(() => prepareRuleReview(record, command, [document], { ...actor, actorId: "maker" })).toThrow("different designated person");
  expect(() => prepareRuleReview(record, command, [document], { ...actor, permissions: new Set() })).toThrow("authority");
  expect(() => prepareRuleReview(record, command, [document], { ...actor, scope: { ...scope, entityId: randomUUID() } })).toThrow("unavailable");
});
it("rejects missing, duplicate and cross-company documents", () => {
  for (const docs of [[], [document, document], [{ ...document, entityId: randomUUID() }], [{ ...document, ruleId: randomUUID() }]]) expect(() => prepareRuleReview(record, command, docs, actor)).toThrow();
  expect(RuleVerification.safeParse({ ...command, sourceDocumentIds: [sourceId, sourceId] }).success).toBe(false);
  expect(RuleVerification.safeParse({ ...command, verifiedBy: "forged" }).success).toBe(false);
});
it("rejects tampered bytes, metadata, future captures and lost retention holds", () => {
  for (const patch of [{ bytes: new TextEncoder().encode("Changed file") }, { bytes: new Uint8Array() }, { sha256: "b".repeat(64) }, { title: "Other" }, { url: "https://example.invalid/other" }, { capturedAt: "2027-01-01T00:00:00Z" }, { retentionHeld: false }]) expect(() => prepareRuleReview(record, command, [{ ...document, ...patch }], actor)).toThrow();
});
it("requires every declared source and section without unrelated selections", () => {
  expect(() => prepareRuleReview(record, { ...command, sourceSections: ["B"] }, [document], actor)).toThrow();
  expect(() => prepareRuleReview({ ...record, policy: { ...record.policy, sourceReferences: [...record.policy.sourceReferences, { ...record.policy.sourceReferences[0], section: "B" }] } }, command, [document], actor)).toThrow();
  expect(() => prepareRuleReview(record, { ...command, sourceSections: ["A", "B"] }, [document], actor)).toThrow();
});
it("does not release quarantined/rejected or demo evidence for real rules", () => {
  for (const scanState of ["quarantined", "rejected"]) expect(() => prepareRuleReview(record, command, [{ ...document, scanState }], actor)).toThrow("eligible");
  expect(() => prepareRuleReview({ ...record, policy: { ...record.policy, demoOnly: false } }, command, [{ ...document, scanState: "clean" }], actor)).toThrow("Demo evidence");
  expect(() => prepareRuleReview(record, command, [document], { ...actor, scope: { ...scope, companyDemo: false } })).toThrow("live company");
});
it("runs independent integer-rational cases for every supported tax definition", () => {
  for (const rate of ["0.00000001", "10", "12.3456789", "100"]) for (const basis of ["exclusive", "inclusive"] as const) expect(runTaxRuleTests({ ...record, policy: { ...record.policy, definition: { ...record.policy.definition, rate, basis } } }).passed).toBe(true);
  for (const treatment of ["exempt", "zero_rated", "out_of_scope"]) expect(runTaxRuleTests({ ...record, policy: { ...record.policy, definition: { method: "no_tax", treatment, rounding: "half_up_line", inputCredit: "not_applicable" } } }).passed).toBe(true);
  const result = runTaxRuleTests(record); expect(result.cases).toHaveLength(7); expect(Object.isFrozen(result.cases)).toBe(true); expect(result).not.toHaveProperty("ruleTestRunId");
});
it("selects an exact active applicability and returns an immutable calculation snapshot", () => {
  const result = resolveTaxRule(resolution, [candidate()]); expect(result).toMatchObject({ ruleId: id, activeVersion: 3, reviewedVersion: 1, demoOnly: true });
  expect(Object.isFrozen(result.definition)).toBe(true); expect(result.sourceDocumentIds).toEqual([sourceId]);
});
it("blocks missing, inactive, expired, wrong-kind, wrong-code and foreign-scope rules", () => {
  const selected = candidate();
  for (const records of [[], [{ ...selected, record }], [{ ...selected, record: { ...selected.record, status: "retired" as const } }], [{ ...selected, record: { ...selected.record, entityId: randomUUID() } }]]) expect(() => resolveTaxRule(resolution, records)).toThrow();
  for (const patch of [{ businessDate: "2027-01-01" }, { businessDate: "2025-12-31" }, { taxCode: "OTHER" }, { kind: "purchase_tax", event: "bill" }, { event: "bill" }]) expect(() => resolveTaxRule({ ...resolution, ...patch }, [selected])).toThrow();
  expect(resolveTaxRule({ ...resolution, businessDate: "2026-01-01" }, [selected]).ruleId).toBe(id);
});
it("blocks overlap even if one candidate has stale evidence or is synthetic in a live scope", () => {
  expect(() => resolveTaxRule(resolution, [candidate(), { ...candidate(), review: undefined }])).toThrow("More than one active");
  expect(() => resolveTaxRule({ ...resolution, companyDemo: false }, [candidate()])).toThrow("live company");
});
it("invalidates evidence after rate, applicability, date, scope, fingerprint or version changes", () => {
  const selected = candidate();
  for (const patch of [{ contentHash: "f".repeat(64) }, { version: 1 }, { createdBy: "reviewer" }, { evaluatorVersion: "unknown" },
    { policy: { ...record.policy, definition: { ...record.policy.definition, rate: "11" } } }, { policy: { ...record.policy, effectiveFrom: "2026-02-01" } }]) expect(() => resolveTaxRule(resolution, [{ ...selected, record: { ...selected.record, ...patch } }])).toThrow();
});
it("rejects absent, failed, incomplete or mismatched evaluator/review receipts", () => {
  const selected = candidate(), tests = runTaxRuleTests(record), review = reviewed();
  for (const replacement of [undefined, { ...tests, passed: false }, { ...tests, cases: tests.cases.slice(1) }, { ...tests, ruleId: randomUUID() }, { ...tests, sourceVersion: 2 }, { ...tests, suiteVersion: "unsupported" }, { ...tests, cases: tests.cases.map(c => ({ ...c, passed: false })) }]) expect(() => resolveTaxRule(resolution, [{ ...selected, tests: replacement as RuleCandidate["tests"] }])).toThrow();
  for (const replacement of [undefined, { ...review, verifiedBy: "maker" }, { ...review, policyHash: "d".repeat(64) }, { ...review, verifiedAt: "2027-01-01T00:00:00Z" }, { ...review, documents: review.documents.map(d => ({ ...d, retentionHeld: false })) }]) expect(() => resolveTaxRule(resolution, [{ ...selected, review: replacement }])).toThrow();
});
it("detects evaluator mutations instead of generating its own expected results", () => {
  const evaluator = vi.spyOn(taxRules, "previewTax").mockImplementation(() => ({ net: "1.00", tax: "0.00", gross: "1.00", inputTaxCredit: "0.00", treatment: "taxable", evaluatorVersion: "tax-line-v1" }));
  try { expect(runTaxRuleTests(record).passed).toBe(false); }
  finally { evaluator.mockRestore(); }
});
it("normalizes unequal timestamp precision and retains the final microsecond", () => {
  const now = "2026-10-13T00:00:00.000001Z";
  expect(prepareRuleReview({ ...record, createdAt: "2026-10-13T00:00:00Z" }, command, [{ ...document, capturedAt: "2026-10-13T00:00:00.000001Z" }], { ...actor, scope: { ...scope, now } }).verifiedAt).toBe(now);
  expect(() => prepareRuleReview(record, command, [{ ...document, capturedAt: "2026-10-13T00:00:00.000002Z" }], { ...actor, scope: { ...scope, now } })).toThrow();
});
it("allows one retained source to cover several explicitly reviewed sections", () => {
  const multi = { ...record, policy: { ...record.policy, sourceReferences: [...record.policy.sourceReferences, { ...record.policy.sourceReferences[0], section: "B" }] } };
  expect(prepareRuleReview(multi, { ...command, sourceSections: ["A", "B"] }, [document], actor).documents).toHaveLength(1);
});
it("rechecks distinct, related metadata when resolving retained receipts", () => {
  const selected = candidate(), review = reviewed();
  for (const patch of [{ documents: [...review.documents, ...review.documents] }, { sourceSections: ["A", "A"] }, { sourceSections: ["A", "B"] }, { documents: [...review.documents, { ...review.documents[0], id: randomUUID(), title: "Unrelated" }] }]) expect(() => resolveTaxRule(resolution, [{ ...selected, review: { ...review, ...patch } }])).toThrow();
});
