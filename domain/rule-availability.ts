import { z } from "zod";
import { CalendarDate } from "./finance-setup";
import { RuleApplicability } from "./tax-rules";
export const RuleAvailabilityQuery = RuleApplicability.extend({ kind: z.enum(["sales_tax", "purchase_tax"]), businessDate: CalendarDate });
