import type { PoolClient } from "pg";
import { databasePool } from "@/db/client";
import { permissionsFor } from "@/domain/permissions";
import { DomainError } from "@/domain/errors";

export async function withScope<T>(userId: string, organizationId: string, entityId: string | null, permission: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await databasePool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id',$1,true),set_config('app.org_id',$2,true),set_config('app.entity_id',$3,true)", [userId, organizationId, entityId ?? ""]);
    const membership = await client.query("SELECT roles,allowed_entity_ids FROM memberships WHERE organization_id=$1 AND user_id=$2 AND active", [organizationId, userId]);
    if (!membership.rowCount) throw new DomainError("NOT_FOUND", "Organization is unavailable.", 404);
    const member = membership.rows[0] as { roles: string[]; allowed_entity_ids: string[] };
    if (entityId && !member.allowed_entity_ids.includes(entityId)) throw new DomainError("NOT_FOUND", "Legal entity is unavailable.", 404);
    if (!permissionsFor(member.roles).has(permission)) throw new DomainError("FORBIDDEN", "You do not have permission for this action.", 403);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally { client.release(); }
}
