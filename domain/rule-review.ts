import { createHash } from "node:crypto";
import { z } from "zod";
import { contentHash, type JsonValue } from "./approvals";
import { DomainError } from "./errors";
import { CalendarDate } from "./finance-setup";
import { PolicyDraft, RuleApplicability, previewTax, taxEvaluatorVersion } from "./tax-rules";

// Internal contracts only. A caller must load records and evidence from trusted,
// scoped repositories; these are not client-provided verification credentials.
const hash = z.string().regex(/^[a-f0-9]{64}$/);
// Normalize precision before lexical comparison; never truncate microseconds.
const Instant = z.iso.datetime().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/)
  .transform(value => `${value.slice(0, 19)}.${value.slice(19, -1).replace(/^\./, "").padEnd(6, "0")}Z`);
export const RuleRecord = z.strictObject({ id: z.uuid(), organizationId: z.uuid(), entityId: z.uuid(), version: z.number().int().positive(),
  contentHash: hash, createdBy: z.string().min(1), createdAt: Instant, evaluatorVersion: z.string().min(1),
  status: z.enum(["draft", "reviewed", "active", "retired"]), policy: PolicyDraft });
export const RuleVerification = z.strictObject({ sourceDocumentIds: z.array(z.uuid()).min(1).max(10), sourceSections: z.array(z.string().trim().min(1).max(500)).min(1).max(10), verificationNote: z.string().trim().min(3).max(2000) })
  .superRefine((value, ctx) => { for (const key of ["sourceDocumentIds", "sourceSections"] as const) if (new Set(value[key]).size !== value[key].length) ctx.addIssue({ code: "custom", path: [key], message: "Use distinct source selections." }); });
const documentFields = { id: z.uuid(), organizationId: z.uuid(), entityId: z.uuid(), ruleId: z.uuid(), title: z.string().min(1).max(300), url: z.url(),
  sha256: hash, capturedAt: Instant, scanState: z.enum(["clean", "demo_fixture", "quarantined", "rejected"]), demoOnly: z.boolean(), retentionHeld: z.boolean() };
const EvidenceDocument = z.strictObject({ ...documentFields, bytes: z.instanceof(Uint8Array) });
const Scope = z.strictObject({ organizationId: z.uuid(), entityId: z.uuid(), companyDemo: z.boolean(), now: Instant });
function fail(message: string): never { throw new DomainError("RULE_NOT_VERIFIED", message); }
const policyHash = (record: z.infer<typeof RuleRecord>) => contentHash(record.policy as JsonValue);
function scoped(record: z.infer<typeof RuleRecord>, scope: z.infer<typeof Scope>) {
  if (record.organizationId !== scope.organizationId || record.entityId !== scope.entityId) throw new DomainError("NOT_FOUND", "Rule is unavailable.", 404);
  if (record.evaluatorVersion !== taxEvaluatorVersion) fail("Rule evaluator is unsupported.");
  if (record.policy.demoOnly && !scope.companyDemo) fail("Synthetic rules cannot be used by a live company.");
}
const DocumentSnapshot = z.strictObject(documentFields);
export const ReviewReceipt = z.strictObject({ ruleId: z.uuid(), organizationId: z.uuid(), entityId: z.uuid(), sourceVersion: z.number().int().positive(), contentHash: hash, policyHash: hash,
  demoOnly: z.boolean(), verifiedBy: z.string().min(1), verifiedAt: Instant, verificationNote: z.string().min(3).max(2000), sourceSections: z.array(z.string()).min(1).max(10), documents: z.array(DocumentSnapshot).min(1).max(10) });

/** Validates actual retained bytes and prepares evidence; does not persist a review. */
export function prepareRuleReview(recordInput: unknown, commandInput: unknown, documentsInput: unknown, context: { scope: z.input<typeof Scope>; actorId: string; permissions: ReadonlySet<string> }) {
  const record = RuleRecord.parse(recordInput), command = RuleVerification.parse(commandInput), scope = Scope.parse(context.scope);
  scoped(record, scope);
  if (!context.permissions.has("rules.verify")) throw new DomainError("FORBIDDEN", "Designated rule reviewer authority is required.", 403);
  if (!context.actorId || context.actorId === record.createdBy) throw new DomainError("SELF_REVIEW", "A different designated person must review the rule.", 403);
  if (record.status !== "draft") throw new DomainError("INVALID_STATE", "Only a draft may be reviewed.", 409);
  if (record.createdAt > scope.now) fail("Rule creation cannot follow verification.");
  const documents = z.array(EvidenceDocument).max(10).parse(documentsInput);
  if (new Set(documents.map(doc => doc.id)).size !== documents.length || documents.length !== command.sourceDocumentIds.length || documents.some(doc => !command.sourceDocumentIds.includes(doc.id))) fail("Load exactly the selected distinct retained documents.");
  for (const doc of documents) {
    if (doc.organizationId !== scope.organizationId || doc.entityId !== scope.entityId || doc.ruleId !== record.id) throw new DomainError("NOT_FOUND", "Source document is unavailable.", 404);
    if (!doc.retentionHeld || doc.capturedAt > scope.now || !doc.bytes.byteLength || doc.bytes.byteLength > 10 * 1024 * 1024) fail("Retained source content or capture evidence is missing.");
    if (doc.scanState !== "clean" && !(doc.scanState === "demo_fixture" && doc.demoOnly && record.policy.demoOnly && scope.companyDemo)) fail("Source document is not eligible for release.");
    if (doc.demoOnly && !record.policy.demoOnly) fail("Demo evidence cannot certify a real rule.");
    if (createHash("sha256").update(doc.bytes).digest("hex") !== doc.sha256) fail("Captured source bytes do not match their fingerprint.");
  }
  for (const ref of record.policy.sourceReferences) if (!command.sourceSections.includes(ref.section) || !documents.some(doc => doc.sha256 === ref.sha256 && doc.title === ref.title && doc.url === ref.url)) fail("Every declared source and section must be covered by retained evidence.");
  for (const doc of documents) if (!record.policy.sourceReferences.some(ref => ref.sha256 === doc.sha256 && ref.title === doc.title && ref.url === doc.url)) fail("Selected evidence must belong to the declared sources.");
  if (command.sourceSections.some(section => !record.policy.sourceReferences.some(ref => ref.section === section))) fail("Review sections must match the declared sources.");
  const receipt = ReviewReceipt.parse({ ruleId: record.id, organizationId: record.organizationId, entityId: record.entityId, sourceVersion: record.version,
    contentHash: record.contentHash, policyHash: policyHash(record), demoOnly: record.policy.demoOnly, verifiedBy: context.actorId, verifiedAt: scope.now,
    verificationNote: command.verificationNote, sourceSections: command.sourceSections,
    documents: documents.map(doc => DocumentSnapshot.parse(Object.fromEntries(Object.keys(documentFields).map(key => [key, doc[key as keyof typeof documentFields]])))) });
  for (const doc of receipt.documents) Object.freeze(doc);
  Object.freeze(receipt.documents); Object.freeze(receipt.sourceSections); return Object.freeze(receipt);
}

const testSuiteVersion = "tax-line-suite-v1";
const cases = ["0.00", "0.01", "0.05", "1.00", "33000.00", "10000000000000000.01", "999999999999999999.99"] as const;
const maximumUnits = 99999999999999999999n;
const format = (units: bigint) => `${units / 100n}.${String(units % 100n).padStart(2, "0")}`;
const round = (numerator: bigint, denominator: bigint) => (2n * numerator + denominator) / (2n * denominator);
/** Independent integer-rational oracle; never calls Decimal or previewTax. */
function expectedLine(definition: z.infer<typeof PolicyDraft>["definition"], amount: string): ReturnType<typeof previewTax> | { error: "MONEY_OVERFLOW" } {
  const base = BigInt(amount.replace(".", "")); let net = base, tax = 0n;
  if (definition.method === "percentage") {
    const [whole, fraction = ""] = definition.rate.split("."), rate = BigInt(whole + fraction.padEnd(8, "0")), denominator = 10000000000n;
    if (definition.basis === "inclusive") { net = round(base * denominator, denominator + rate); tax = base - net; }
    else tax = round(base * rate, denominator);
  }
  if (net + tax > maximumUnits) return { error: "MONEY_OVERFLOW" as const };
  return { net: format(net), tax: format(tax), gross: format(net + tax), inputTaxCredit: definition.method === "percentage" && definition.inputCredit === "eligible" ? format(tax) : "0.00",
    treatment: definition.method === "percentage" ? "taxable" : definition.treatment, evaluatorVersion: taxEvaluatorVersion };
}
export const RuleTestReceipt = z.strictObject({ ruleId: z.uuid(), sourceVersion: z.number().int().positive(), contentHash: hash, policyHash: hash,
  evaluatorVersion: z.literal(taxEvaluatorVersion), suiteVersion: z.literal(testSuiteVersion), passed: z.boolean(),
  cases: z.array(z.strictObject({ base: z.string(), passed: z.boolean() })).length(cases.length) });
/** Returns a computation result, not a persisted/authorized ruleTestRunId. */
export function runTaxRuleTests(recordInput: unknown) {
  const record = RuleRecord.parse(recordInput);
  if (record.evaluatorVersion !== taxEvaluatorVersion) fail("Rule evaluator is unsupported.");
  const outcomes = cases.map(base => {
    const expected = expectedLine(record.policy.definition, base);
    try { const actual = previewTax(record.policy.definition, base); return { base, passed: !("error" in expected) && contentHash(actual) === contentHash(expected) }; }
    catch (error) { return { base, passed: "error" in expected && error instanceof DomainError && error.code === expected.error }; }
  });
  const receipt = RuleTestReceipt.parse({ ruleId: record.id, sourceVersion: record.version, contentHash: record.contentHash, policyHash: policyHash(record), evaluatorVersion: taxEvaluatorVersion,
    suiteVersion: testSuiteVersion, passed: outcomes.every(outcome => outcome.passed), cases: outcomes });
  for (const outcome of receipt.cases) Object.freeze(outcome); Object.freeze(receipt.cases); return Object.freeze(receipt);
}

export const RuleResolution = Scope.extend({ ...RuleApplicability.shape, kind: z.enum(["sales_tax", "purchase_tax"]), businessDate: CalendarDate });
export type RuleCandidate = { record: z.input<typeof RuleRecord>; review?: z.input<typeof ReviewReceipt>; tests?: z.input<typeof RuleTestReceipt> };
/** Pure selection from trusted snapshots; does not load, activate or post a rule. */
export function resolveTaxRule(contextInput: unknown, candidates: readonly RuleCandidate[]) {
  const scope = RuleResolution.parse(contextInput);
  if (scope.event !== (scope.kind === "sales_tax" ? "invoice" : "bill")) fail("Transaction event does not match the rule kind.");
  const matching = candidates.map(candidate => ({ ...candidate, record: RuleRecord.parse(candidate.record) })).filter(({ record }) =>
    record.organizationId === scope.organizationId && record.entityId === scope.entityId && record.policy.kind === scope.kind &&
    record.policy.applicability.event === scope.event && record.policy.applicability.taxCode === scope.taxCode && record.policy.effectiveFrom <= scope.businessDate &&
    (!record.policy.effectiveTo || scope.businessDate < record.policy.effectiveTo));
  const active = matching.filter(candidate => candidate.record.status === "active");
  if (active.length > 1) throw new DomainError("RULE_OVERLAP", "More than one active rule covers this applicability and date.", 409);
  if (!active.length) fail("No verified active rule covers this applicability and date.");
  const { record, review: reviewInput, tests: testsInput } = active[0]; scoped(record, scope);
  const review = ReviewReceipt.safeParse(reviewInput), tests = RuleTestReceipt.safeParse(testsInput), currentHash = policyHash(record);
  if (!review.success || !tests.success) fail("Source review and evaluator test evidence are required.");
  const r = review.data, t = tests.data;
  if (new Set(r.documents.map(doc => doc.id)).size !== r.documents.length || new Set(r.sourceSections).size !== r.sourceSections.length) fail("Review evidence selections must remain distinct.");
  if (r.ruleId !== record.id || r.organizationId !== scope.organizationId || r.entityId !== scope.entityId || r.contentHash !== record.contentHash || r.policyHash !== currentHash || r.sourceVersion !== t.sourceVersion || r.sourceVersion >= record.version || r.demoOnly !== record.policy.demoOnly || r.verifiedBy === record.createdBy || r.verifiedAt > scope.now || r.verifiedAt < record.createdAt) fail("Source review is stale, mismatched or not independent.");
  if (t.ruleId !== record.id || t.contentHash !== record.contentHash || t.policyHash !== currentHash || !t.passed || t.cases.some((outcome, index) => !outcome.passed || outcome.base !== cases[index])) fail("Evaluator test evidence is stale, failed or incomplete.");
  // Revalidate immutable retained metadata; future storage repositories must
  // also enforce current access, holds and scanner state before supplying it.
  for (const doc of r.documents) if (doc.organizationId !== scope.organizationId || doc.entityId !== scope.entityId || doc.ruleId !== record.id || !doc.retentionHeld || doc.capturedAt > r.verifiedAt ||
    (doc.scanState !== "clean" && !(doc.scanState === "demo_fixture" && doc.demoOnly && record.policy.demoOnly && scope.companyDemo)) || (doc.demoOnly && !record.policy.demoOnly)) fail("Review source evidence is not eligible.");
  for (const ref of record.policy.sourceReferences) if (!r.sourceSections.includes(ref.section) || !r.documents.some(doc => doc.sha256 === ref.sha256 && doc.title === ref.title && doc.url === ref.url)) fail("Review no longer covers all declared sources.");
  if (r.documents.some(doc => !record.policy.sourceReferences.some(ref => ref.sha256 === doc.sha256 && ref.title === doc.title && ref.url === doc.url)) ||
    r.sourceSections.some(section => !record.policy.sourceReferences.some(ref => ref.section === section))) fail("Review contains unrelated source evidence.");
  const definition = Object.freeze({ ...record.policy.definition });
  return Object.freeze({ ruleId: record.id, activeVersion: record.version, reviewedVersion: r.sourceVersion, contentHash: record.contentHash, policyHash: currentHash,
    evaluatorVersion: taxEvaluatorVersion, verifiedBy: r.verifiedBy, verifiedAt: r.verifiedAt, demoOnly: record.policy.demoOnly, definition,
    sourceDocumentIds: Object.freeze(r.documents.map(doc => doc.id)) });
}
