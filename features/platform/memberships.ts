import { randomUUID, createHash } from "node:crypto";
import type { z } from "zod";
import { withScope } from "@/features/identity/scope";
import { DomainError } from "@/domain/errors";
import { MembershipChange, MembershipDTO } from "./contracts";
import { audit, memberDTO } from "./service";

export async function listMembers(user: string, org: string, limit: number, cursor?: string) {
  return withScope(user, org, null, "membership.read", async client => {
    const rows = await client.query("SELECT * FROM memberships WHERE organization_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3", [org, cursor ?? null, limit + 1]);
    const data = rows.rows.slice(0, limit).map(memberDTO); return { data, nextCursor: rows.rows.length > limit ? data.at(-1)!.id : null };
  });
}
export async function changeMember(user: string, org: string, input: z.infer<typeof MembershipChange>, requestId: string, options: { key?: string; id?: string; version?: number }) {
  if (input.userId === user) throw new DomainError("SELF_ESCALATION", "Another administrator must change your membership.", 403);
  return withScope(user, org, null, options.id ? "membership.update" : "membership.create", async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [org]);
    if (!(await client.query("SELECT id FROM auth_user WHERE id=$1 AND email_verified", [input.userId])).rowCount) throw new DomainError("INVALID_IDENTITY", "Membership needs an existing verified identity.");
    let id = options.id;
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    if (!id) {
      const previous = await client.query("SELECT * FROM idempotency_results WHERE organization_id=$1 AND principal_id=$2 AND operation='membership.create' AND key=$3", [org, user, options.key]);
      if (previous.rowCount) {
        if (previous.rows[0].request_hash !== hash) throw new DomainError("IDEMPOTENCY_CONFLICT", "This key was used with a different request.", 409);
        return MembershipDTO.parse(previous.rows[0].response);
      }
      id = randomUUID();
      await client.query("INSERT INTO memberships(id,organization_id,user_id,roles,allowed_entity_ids,site_ids,active) VALUES($1,$2,$3,$4,$5,$6,$7)", [id, org, input.userId, JSON.stringify(input.roleIds), JSON.stringify(input.allowedEntityIds), JSON.stringify(input.siteIds), input.active]);
    } else {
      const old = await client.query("SELECT * FROM memberships WHERE id=$1 AND organization_id=$2 FOR UPDATE", [id, org]);
      if (!old.rowCount) throw new DomainError("NOT_FOUND", "Membership is unavailable.", 404);
      if (old.rows[0].user_id !== input.userId) throw new DomainError("IMMUTABLE_IDENTITY", "Membership user cannot change.");
      if (old.rows[0].version !== options.version) throw new DomainError("STALE_VERSION", "Reload the current membership.", 412);
      await client.query("UPDATE memberships SET roles=$2,allowed_entity_ids=$3,site_ids=$4,active=$5,version=version+1 WHERE id=$1", [id, JSON.stringify(input.roleIds), JSON.stringify(input.allowedEntityIds), JSON.stringify(input.siteIds), input.active]);
    }
    await audit(client, org, user, options.id ? "membership.update" : "membership.create", id, requestId);
    const rows = await client.query("SELECT * FROM memberships WHERE id=$1", [id]), response = memberDTO(rows.rows[0]);
    if (!options.id) await client.query("INSERT INTO idempotency_results(id,organization_id,principal_id,operation,key,request_hash,resource_id,response) VALUES($1,$2,$3,'membership.create',$4,$5,$6,$7)", [randomUUID(), org, user, options.key, hash, id, JSON.stringify(response)]);
    return response;
  });
}
