import { databasePool } from "@/db/client";
import { memberDTO } from "@/features/platform/service";

export async function sessionMemberships(userId: string) {
  const client = await databasePool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id',$1,true),set_config('app.org_id','',true),set_config('app.entity_id','',true)", [userId]);
    const memberships = await client.query("SELECT * FROM memberships WHERE user_id=$1 AND active ORDER BY organization_id", [userId]);
    await client.query("COMMIT");
    return memberships.rows.map(memberDTO);
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}
