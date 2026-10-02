import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { z } from "zod";
import { DomainError } from "@/domain/errors";
import { contentHash } from "@/domain/approvals";
import { withScope } from "@/features/identity/scope";
import { replay, remember } from "@/features/platform/idempotency";
import { audit } from "@/features/platform/service";
import { JobDTO, JobResult, Reason } from "./contracts";

async function authorize(client: PoolClient, org: string, entity: string) {
  await client.query("SELECT app_security.lock_policy_scope($1,$2)", [org, entity]);
  const allowed = await client.query("SELECT app_security.can_activate_policy($1) AND app_security.can_entity($1,$2) AS allowed", [org, entity]);
  if (!allowed.rows[0].allowed) throw new DomainError("FORBIDDEN", "Job access requires current designated reviewer and finance or admin authority.", 403);
}
async function selected(client: PoolClient, user: string, org: string, entity: string, id: string) {
  const rows = await client.query("SELECT * FROM outbox_events WHERE organization_id=$1 AND legal_entity_id=$2 AND id=$3 AND principal_id=$4 FOR UPDATE", [org, entity, id, user]);
  if (!rows.rowCount) throw new DomainError("NOT_FOUND", "Delivery job is unavailable.", 404);
  return rows.rows[0];
}
export async function getJob(user: string, org: string, entity: string, id: string) {
  return withScope(user, org, entity, "jobs.read", async client => {
    await authorize(client, org, entity);
    const row = await selected(client, user, org, entity, id);
    const history = await client.query("SELECT from_version,reason,request_id,created_at FROM job_retries WHERE event_id=$1 AND organization_id=$2 AND legal_entity_id=$3 AND principal_id=$4 ORDER BY from_version", [id, org, entity, user]);
    return JobDTO.parse({ id: row.id, organizationId: org, entityId: entity, version: row.version, type: row.kind, schemaVersion: 1,
      sourceId: row.policy_id, sourceVersion: row.source_version, inputHash: row.source_hash, status: row.status,
      attempts: row.attempts, totalAttempts: row.total_attempts, retryCount: row.retry_count, maxRetries: 3, totalItems: 1, completedItems: row.status === "delivered" ? 1 : 0,
      availableAt: row.available_at.toISOString(), leaseExpiresAt: row.lease_until?.toISOString() ?? null, errorCode: row.last_error_code,
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null,
      retryHistory: history.rows.map(r => ({ fromVersion: r.from_version, reason: r.reason, requestId: r.request_id, createdAt: r.created_at.toISOString() })) });
  });
}
export async function retryJob(user: string, org: string, entity: string, id: string, input: z.infer<typeof Reason>, version: number, key: string, requestId: string) {
  const command = Reason.parse(input);
  return withScope(user, org, entity, "jobs.update", async client => {
    await authorize(client, org, entity);
    const row = await selected(client, user, org, entity, id);
    const eligible = await client.query(`SELECT EXISTS(SELECT 1 FROM approval_policies WHERE organization_id=$1 AND legal_entity_id=$2 AND id=$3 AND status='active' AND version=$4 AND content_hash=$5)
      AND app_security.policy_alert_recipient_eligible($1,$2,$6) AS allowed`, [org, entity, row.policy_id, row.source_version, row.source_hash, row.recipient_id]);
    if (!eligible.rows[0].allowed) throw new DomainError("JOB_SOURCE_UNAVAILABLE", "Current source or recipient authority is unavailable.", 409);
    const operation = `job.retry:${entity}`, hash = contentHash({ id, version, ...command });
    const prior = await replay(client, org, user, operation, key, hash);
    if (prior) return JobResult.parse(prior);
    if (row.version !== version) throw new DomainError("STALE_VERSION", "Reload the job before retrying.", 412);
    if (row.status !== "failed") throw new DomainError("INVALID_TRANSITION", "Only a failed job can be retried.", 409);
    if (row.retry_count >= 3) throw new DomainError("RETRY_LIMIT", "This job has exhausted its three manual recovery cycles.", 409);
    await client.query("INSERT INTO job_retries(id,organization_id,legal_entity_id,event_id,principal_id,from_version,reason,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [randomUUID(), org, entity, id, user, version, command.reason, requestId]);
    const updated = await client.query("UPDATE outbox_events SET status='pending',attempts=0,retry_count=retry_count+1,available_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,completed_at=NULL,last_error_code=NULL WHERE id=$1 RETURNING version", [id]);
    const response = JobResult.parse({ jobId: id, status: "pending", version: updated.rows[0].version, statusUrl: `/api/v1/orgs/${org}/entities/${entity}/jobs/${id}` });
    await audit(client, org, user, "job.retry", id, requestId, entity);
    await remember(client, org, user, operation, key, hash, id, response);
    return response;
  });
}
