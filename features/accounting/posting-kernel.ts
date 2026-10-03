import type { PoolClient } from "pg";
import { z } from "zod";
import { prepareManualPosting } from "@/domain/posting";

export type PostedJournalReceipt = { id: string; number: string; debit: string; credit: string };

/**
 * Internal transaction primitive, NOT an approved-document adapter.
 * Runtime EXECUTE is deliberately withheld until persisted maker/checker
 * decisions and source transitions are integrated. No HTTP route calls this.
 * The caller owns BEGIN/COMMIT so subsequent source failures roll back numbering.
 */
export async function writeManualJournal(client: PoolClient, organizationId: string, entityId: string, sourceId: string, value: unknown, requestId: string): Promise<PostedJournalReceipt> {
  z.uuid().parse(organizationId); z.uuid().parse(entityId); z.uuid().parse(sourceId);
  z.string().trim().min(1).max(200).parse(requestId);
  const { posting } = prepareManualPosting(value);
  const result = await client.query<PostedJournalReceipt>(
    "SELECT id,number,total_debit::text AS debit,total_credit::text AS credit FROM app_security.write_manual_journal($1,$2,$3,$4::jsonb,$5)",
    [organizationId, entityId, sourceId, JSON.stringify(posting), requestId],
  );
  return result.rows[0];
}
