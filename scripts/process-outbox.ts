import { config } from "dotenv";
import { z } from "zod";
import { databasePool } from "../db/client";
import { processPolicyBatch } from "../features/jobs/outbox";
config({ path: ".env.local", quiet: true });
// One bounded batch with explicit current principal/org/entity. No unscoped scan.
const scope = z.strictObject({ user: z.string().min(1).max(200), org: z.uuid(), entity: z.uuid(), limit: z.coerce.number().int().min(1).max(25).default(10) }).safeParse({
  user: process.env.OUTBOX_USER_ID, org: process.env.OUTBOX_ORGANIZATION_ID, entity: process.env.OUTBOX_ENTITY_ID, limit: process.env.OUTBOX_BATCH_LIMIT,
});
if (!scope.success) throw new Error("Provide explicit outbox user, organization, entity and bounded batch configuration.");
try {
  console.log(JSON.stringify(await processPolicyBatch(scope.data.user, scope.data.org, scope.data.entity, scope.data.limit)));
} catch {
  console.error("Scoped outbox processing failed; inspect access/configuration and the redacted event status.");
  process.exitCode = 1;
} finally { await databasePool().end(); }
