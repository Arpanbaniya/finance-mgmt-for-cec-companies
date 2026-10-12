import { z } from "zod";
import { CalendarDate } from "./finance-setup";
import { decimal, Exact, money } from "./money";
import { DomainError } from "./errors";

// Finite declarative vocabulary. No formula, script, or legal-rate fallback.
export const taxEvaluatorVersion = "tax-line-v1";
const ratePattern = /^(?:0|[1-9]\d{0,2})(?:\.\d{1,8})?$/;
export const TaxDefinition = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("percentage"), rate: z.string().regex(ratePattern)
    .refine(value => ratePattern.test(value) && new Exact(value).greaterThan(0) && new Exact(value).lessThanOrEqualTo(100), "Percentage must be greater than zero and at most 100."),
    basis: z.enum(["exclusive", "inclusive"]), rounding: z.literal("half_up_line"), inputCredit: z.enum(["not_applicable", "eligible", "ineligible"]) }),
  z.strictObject({ method: z.literal("no_tax"), treatment: z.enum(["zero_rated", "exempt", "out_of_scope"]), rounding: z.literal("half_up_line"), inputCredit: z.literal("not_applicable") }),
]);
export const RuleApplicability = z.strictObject({ event: z.enum(["invoice", "bill"]), taxCode: z.string().trim().regex(/^[A-Z][A-Z0-9_-]{0,39}$/) });
export const SourceReference = z.strictObject({
  title: z.string().trim().min(1).max(300), url: z.url().max(2000).refine(value => {
    try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
  }, "Use an HTTPS reference without embedded credentials."),
  section: z.string().trim().min(1).max(500), sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const fields = {
  kind: z.enum(["sales_tax", "purchase_tax"]), applicability: RuleApplicability,
  effectiveFrom: CalendarDate, effectiveTo: CalendarDate.optional(), definition: TaxDefinition,
  sourceReferences: z.array(SourceReference).min(1).max(10), demoOnly: z.boolean(),
};
export const PolicyDraft = z.strictObject(fields).superRefine((value, ctx) => {
  if (value.effectiveTo && value.effectiveTo <= value.effectiveFrom) ctx.addIssue({ code: "custom", path: ["effectiveTo"], message: "Exclusive end date must follow the start date." });
  if (value.applicability.event !== (value.kind === "sales_tax" ? "invoice" : "bill")) ctx.addIssue({ code: "custom", path: ["applicability", "event"], message: "Event must match the rule kind." });
  if (value.definition.method === "percentage" && ((value.kind === "sales_tax") !== (value.definition.inputCredit === "not_applicable")))
    ctx.addIssue({ code: "custom", path: ["definition", "inputCredit"], message: "Sales tax has no input credit; purchase percentage tax needs an explicit eligibility choice." });
  const fingerprints = value.sourceReferences.map(source => `${source.url}\n${source.section}\n${source.sha256}`);
  if (new Set(fingerprints).size !== fingerprints.length) ctx.addIssue({ code: "custom", path: ["sourceReferences"], message: "Do not repeat source references." });
});
export type TaxRuleInput = z.input<typeof PolicyDraft>;

// Arithmetic preview only: never decides applicability, verification, or posting authority.
export function previewTax(definitionInput: unknown, baseInput: unknown) {
  const definition = TaxDefinition.parse(definitionInput), base = decimal(baseInput);
  if (base.isNegative()) throw new DomainError("INVALID_TAX_BASE", "Use a nonnegative tax base. Credit notes require a separate controlled workflow.");
  let net = base, tax = new Exact(0);
  if (definition.method === "percentage") {
    const fraction = decimal(definition.rate, 8).div(100);
    if (definition.basis === "inclusive") { net = new Exact(money(base.div(fraction.plus(1)))); tax = base.minus(net); }
    else tax = new Exact(money(base.times(fraction)));
  }
  return { net: money(net), tax: money(tax), gross: money(net.plus(tax)),
    inputTaxCredit: definition.method === "percentage" && definition.inputCredit === "eligible" ? money(tax) : "0.00",
    treatment: definition.method === "percentage" ? "taxable" as const : definition.treatment, evaluatorVersion: taxEvaluatorVersion };
}
