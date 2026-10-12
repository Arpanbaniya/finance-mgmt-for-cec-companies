import { expect, it } from "vitest";
import { PolicyDraft, TaxDefinition, previewTax } from "@/domain/tax-rules";
const percentage = { method: "percentage", rate: "10", basis: "exclusive", rounding: "half_up_line", inputCredit: "not_applicable" };
const draft = { kind: "sales_tax", applicability: { event: "invoice", taxCode: "DEMO_OUTPUT" }, effectiveFrom: "2026-01-01", effectiveTo: "2027-01-01",
  definition: percentage, demoOnly: true, sourceReferences: [{ title: "Synthetic fixture, not law", url: "https://example.invalid/tax-fixture", section: "A", sha256: "a".repeat(64) }] };
it("reproduces the synthetic 33000 + 10% fixture without claiming law", () => {
  expect(previewTax(percentage, "33000")).toMatchObject({ net: "33000.00", tax: "3300.00", gross: "36300.00", inputTaxCredit: "0.00" });
  expect(PolicyDraft.parse(draft).demoOnly).toBe(true);
});
it("inclusive net plus tax exactly retains gross, including a half-paise split", () => {
  expect(previewTax({ ...percentage, basis: "inclusive" }, "36300")).toMatchObject({ net: "33000.00", tax: "3300.00", gross: "36300.00" });
  expect(previewTax({ ...percentage, basis: "inclusive", rate: "100" }, "0.01")).toMatchObject({ net: "0.01", tax: "0.00", gross: "0.01" });
});
it("rounds independently at the declared line boundary and preserves huge exact money", () => {
  expect(previewTax(percentage, "0.05").tax).toBe("0.01");
  expect(previewTax({ ...percentage, rate: "0.00000001" }, "10000000000000000.01")).toMatchObject({ net: "10000000000000000.01", tax: "1000000.00", gross: "10000000001000000.01" });
  expect(() => previewTax(percentage, "999999999999999999.99")).toThrow("supported range");
});
it("retains distinct zero-rated, exempt and out-of-scope treatments", () => {
  for (const treatment of ["zero_rated", "exempt", "out_of_scope"] as const) expect(previewTax({ method: "no_tax", treatment, rounding: "half_up_line", inputCredit: "not_applicable" }, "123.45")).toMatchObject({ net: "123.45", tax: "0.00", gross: "123.45", treatment });
});
it("requires explicit purchase input-credit eligibility", () => {
  for (const inputCredit of ["eligible", "ineligible"] as const) {
    expect(PolicyDraft.safeParse({ ...draft, kind: "purchase_tax", applicability: { event: "bill", taxCode: "DEMO_INPUT" }, definition: { ...percentage, inputCredit } }).success).toBe(true);
    expect(previewTax({ ...percentage, inputCredit }, "100").inputTaxCredit).toBe(inputCredit === "eligible" ? "10.00" : "0.00");
  }
  expect(PolicyDraft.safeParse({ ...draft, definition: { ...percentage, inputCredit: "eligible" } }).success).toBe(false);
  expect(PolicyDraft.safeParse({ ...draft, kind: "purchase_tax", applicability: { event: "bill", taxCode: "DEMO_INPUT" } }).success).toBe(false);
});
it("rejects numeric, exponent, invalid scale, unsupported rates and arbitrary evaluators", () => {
  for (const rate of [10, "1e1", "-1", "0", "100.00000001", "0.000000001", "01", "Infinity", "select 1", "1e99999999"]) expect(TaxDefinition.safeParse({ ...percentage, rate }).success).toBe(false);
  for (const base of [100, "1e3", "0.001", "-0.01", "NaN"]) expect(() => previewTax(percentage, base)).toThrow();
  expect(TaxDefinition.safeParse({ ...percentage, formula: "eval(x)", rounding: "bankers" }).success).toBe(false);
});
it("rejects scope/actor/status injection and non-finite applicability selectors", () => {
  for (const injected of [{ organizationId: "spoof" }, { verifiedBy: "spoof" }, { status: "active" }, { evaluatorVersion: "sql" }]) expect(PolicyDraft.safeParse({ ...draft, ...injected }).success).toBe(false);
  expect(PolicyDraft.safeParse({ ...draft, applicability: { event: "bill", taxCode: "DEMO_OUTPUT" } }).success).toBe(false);
  expect(PolicyDraft.safeParse({ ...draft, applicability: { ...draft.applicability, expression: "true" } }).success).toBe(false);
});
it("uses explicit half-open AD intervals and bounded, credential-free source metadata", () => {
  for (const effectiveTo of ["2026-01-01", "2025-12-31", "2026-02-30"]) expect(PolicyDraft.safeParse({ ...draft, effectiveTo }).success).toBe(false);
  expect(PolicyDraft.safeParse({ ...draft, effectiveTo: undefined }).success).toBe(true);
  for (const url of ["not a URL", "javascript:alert(1)", "http://example.invalid", "https://user:secret@example.invalid"]) expect(PolicyDraft.safeParse({ ...draft, sourceReferences: [{ ...draft.sourceReferences[0], url }] }).success).toBe(false);
  expect(PolicyDraft.safeParse({ ...draft, sourceReferences: [...draft.sourceReferences, ...draft.sourceReferences] }).success).toBe(false);
  expect(PolicyDraft.safeParse({ ...draft, sourceReferences: [] }).success).toBe(false);
});
