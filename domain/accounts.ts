import { z } from "zod";
export const AccountType = z.enum(["asset", "liability", "equity", "revenue", "expense"]);
export const ControlType = z.enum(["ar", "ap", "cash", "wages_payable", "worker_advances", "tax_receivable", "tax_payable", "statutory_payable", "customer_deposits", "supplier_advances", "staff_advances", "employee_reimbursements"]);
export const ReportMapping = z.strictObject({ statementSection: z.enum(["assets", "liabilities", "equity", "revenue", "expenses"]), cashFlowCategory: z.enum(["unclassified", "operating", "investing", "financing", "cash"]) });
export const statementSections = { asset: "assets", liability: "liabilities", equity: "equity", revenue: "revenue", expense: "expenses" } as const;
export const controlAccountTypes = { ar: "asset", ap: "liability", cash: "asset", wages_payable: "liability", worker_advances: "asset", tax_receivable: "asset", tax_payable: "liability", statutory_payable: "liability", customer_deposits: "liability", supplier_advances: "asset", staff_advances: "asset", employee_reimbursements: "liability" } as const;
export const AccountFields = z.strictObject({ code: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).toUpperCase(), name: z.string().trim().min(1).max(200),
  type: AccountType, normalSide: z.enum(["debit", "credit"]), parentId: z.uuid().nullable().default(null), isControl: z.boolean(), controlType: ControlType.nullable().default(null), reportMapping: ReportMapping });
export const AccountCreate = AccountFields.superRefine((account, context) => {
  if (account.isControl !== (account.controlType !== null)) context.addIssue({ code: "custom", path: ["controlType"], message: "Control accounts require a control type; ordinary accounts cannot have one." });
  if (account.controlType && controlAccountTypes[account.controlType] !== account.type) context.addIssue({ code: "custom", path: ["type"], message: "Account type does not match this control role." });
  if (account.reportMapping.statementSection !== statementSections[account.type]) context.addIssue({ code: "custom", path: ["reportMapping", "statementSection"], message: "Statement section must match the account type." });
  if ((account.controlType === "cash") !== (account.reportMapping.cashFlowCategory === "cash")) context.addIssue({ code: "custom", path: ["reportMapping", "cashFlowCategory"], message: "Only cash control accounts use the cash category." });
});
export const AccountPatch = z.strictObject({ name: AccountFields.shape.name.optional(), parentId: z.uuid().nullable().optional(), reportMapping: ReportMapping.optional() }).refine(value => Object.keys(value).length > 0, "Supply at least one editable field.");
export function isParentCandidate(type: z.infer<typeof AccountType>, id: string | undefined, parent: { id: string; type: string; active: boolean; isControl: boolean }) {
  return parent.active && !parent.isControl && parent.type === type && parent.id !== id;
}
