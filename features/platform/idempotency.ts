import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DomainError } from "@/domain/errors";

// Call only after current authorization and the command's serialization lock.
// Entity-qualified operation namespaces prevent cross-company key collisions.
export async function replay(client: PoolClient, org: string, user: string, operation: string, key: string, hash: string) {
  const prior = await client.query("SELECT * FROM idempotency_results WHERE organization_id=$1 AND principal_id=$2 AND operation=$3 AND key=$4", [org, user, operation, key]);
  if (!prior.rowCount) return null;
  if (prior.rows[0].request_hash !== hash) throw new DomainError("IDEMPOTENCY_CONFLICT", "This key was used with a different request.", 409);
  return prior.rows[0].response;
}
export async function remember(client: PoolClient, org: string, user: string, operation: string, key: string, hash: string, resource: string, response: unknown) {
  await client.query("INSERT INTO idempotency_results(id,organization_id,principal_id,operation,key,request_hash,resource_id,response) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [randomUUID(), org, user, operation, key, hash, resource, JSON.stringify(response)]);
}
