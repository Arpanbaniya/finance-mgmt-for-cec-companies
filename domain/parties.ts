import { z } from "zod";
import { Exact } from "./money";

export const PartyRoles = z.array(z.enum(["customer", "supplier"])).min(1).max(2)
  .refine(roles => new Set(roles).size === roles.length, "Choose each role once.").transform(roles => roles.toSorted());
const optionalText = (maximum: number) => z.string().trim().min(1).max(maximum).nullable();
export const CreditLimit = z.string().regex(/^(?:0|[1-9]\d{0,17})(?:\.\d{1,2})?$/, "Use a nonnegative NPR decimal string with at most two decimal places.")
  .transform(value => new Exact(value).toFixed(2));
const fields = {
  name: z.string().trim().min(1).max(200).transform(value => value.replace(/\s+/g, " ")),
  roleSet: PartyRoles, contact: optionalText(2000), address: optionalText(2000), taxIdentifier: optionalText(100),
  paymentTermsDays: z.number().int().min(0).max(3650), creditLimit: CreditLimit.nullable(),
};
export const PartyCreate = z.strictObject({ ...fields, contact: fields.contact.default(null), address: fields.address.default(null),
  taxIdentifier: fields.taxIdentifier.default(null), paymentTermsDays: fields.paymentTermsDays.default(0), creditLimit: fields.creditLimit.default(null), active: z.literal(true).default(true) })
  .refine(party => party.creditLimit === null || party.roleSet.includes("customer"), { path: ["creditLimit"], message: "Only customers have a credit limit." });
export const PartyPatch = z.strictObject({ name: fields.name.optional(), roleSet: fields.roleSet.optional(), contact: fields.contact.optional(),
  address: fields.address.optional(), taxIdentifier: fields.taxIdentifier.optional(), paymentTermsDays: fields.paymentTermsDays.optional(), creditLimit: fields.creditLimit.optional() })
  .refine(patch => Object.keys(patch).length > 0, "Supply at least one editable field.");
