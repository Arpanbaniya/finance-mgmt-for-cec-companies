import { z } from "zod";
import { PostingLine } from "./posting";
import { CalendarDate } from "./finance-setup";
import { validateJournal } from "./accounting";

// Account versions are resolved by the server, never selected by the maker.
export const JournalLineCreate = PostingLine.omit({ accountVersion: true });
const fields = {
  postingDate: CalendarDate, documentDate: CalendarDate,
  description: z.string().trim().min(1).max(1000),
  lines: z.array(JournalLineCreate).min(2).max(500),
};
export const JournalCreate = z.strictObject(fields).superRefine((value, context) => {
  try { validateJournal(value.lines); } catch (error) { context.addIssue({ code: "custom", path: ["lines"], message: error instanceof Error ? error.message : "Journal must balance exactly." }); }
});
export const JournalPatch = z.strictObject({
  postingDate: fields.postingDate.optional(), documentDate: fields.documentDate.optional(),
  description: fields.description.optional(), lines: fields.lines.optional(),
}).refine(value => Object.keys(value).length > 0, "Supply at least one editable field.").superRefine((value, context) => {
  if (value.lines) {
    try { validateJournal(value.lines); } catch (error) { context.addIssue({ code: "custom", path: ["lines"], message: error instanceof Error ? error.message : "Journal must balance exactly." }); }
  }
});
