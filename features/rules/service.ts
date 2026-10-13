import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DomainError } from "@/domain/errors";
import { contentHash } from "@/domain/approvals";
import type { TaxRuleInput } from "@/domain/tax-rules";
import { withScope } from "@/features/identity/scope";
import { audit } from "@/features/platform/service";
import { replay, remember } from "@/features/platform/idempotency";
import { ListQuery, uuid } from "@/features/platform/contracts";
import { PolicyDraft, PolicyDraftDTO } from "./contracts";
import { RuleAvailabilityQuery } from "@/domain/rule-availability";
import { resolveTaxRule } from "@/domain/rule-review";
import type { z } from "zod";
function dto(row: Record<string, unknown>) {
  return PolicyDraftDTO.parse({ ...(row.definition as object), id: row.id, organizationId: row.organization_id, entityId: row.legal_entity_id,
    jurisdiction: row.jurisdiction, currency: row.currency, evaluatorVersion: row.evaluator_version, status: row.status, version: row.version,
    contentHash: row.content_hash, createdBy: row.created_by, createdAt: (row.created_at as Date).toISOString() });
}
async function selected(client: PoolClient, org: string, entity: string, id: string) {
  const rows = await client.query("SELECT * FROM rule_versions WHERE organization_id=$1 AND legal_entity_id=$2 AND id=$3", [org, entity, id]);
  if (!rows.rowCount) throw new DomainError("NOT_FOUND", "Rule draft is unavailable.", 404);
  return dto(rows.rows[0]);
}
export async function listRuleDrafts(user: string, org: string, entity: string, limit: number, cursor?: string) {
  const query = ListQuery.parse({ limit, cursor });
  return withScope(user, org, entity, "rules.read", async client => {
    const rows = await client.query("SELECT * FROM rule_versions WHERE organization_id=$1 AND legal_entity_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4", [org, entity, query.cursor ?? null, query.limit + 1]);
    const data = rows.rows.slice(0, query.limit).map(dto); return { data, nextCursor: rows.rows.length > query.limit ? data.at(-1)!.id : null };
  });
}
export async function getRuleDraft(user: string, org: string, entity: string, id: string) {
  return withScope(user, org, entity, "rules.read", client => selected(client, org, entity, uuid.parse(id)));
}
export async function createRuleDraft(user: string, org: string, entity: string, input: TaxRuleInput, key: string, requestId: string) {
  const command = PolicyDraft.parse(input);
  return withScope(user, org, entity, "rules.create", async client => {
    await client.query("SELECT app_security.lock_policy_scope($1,$2)", [org, entity]);
    const access = await client.query("SELECT app_security.can_manage_accounts($1) AND app_security.finance_setup_scope($1,$2) AS allowed", [org, entity]);
    if (!access.rows[0].allowed) throw new DomainError("FORBIDDEN", "Current finance manager authority is required.", 403);
    const operation = `rule.create:${entity}`, hash = contentHash(command), prior = await replay(client, org, user, operation, key, hash);
    if (prior) return PolicyDraftDTO.parse(prior);
    if (command.demoOnly) {
      const company = await client.query("SELECT policy_status,reporting_profile FROM legal_entities WHERE organization_id=$1 AND id=$2", [org, entity]);
      if (company.rows[0]?.policy_status !== "demo" || company.rows[0]?.reporting_profile !== "demo_accrual") throw new DomainError("DEMO_RULE_FORBIDDEN", "Synthetic drafts require a demo company.", 409);
    }
    const rows = await client.query("INSERT INTO rule_versions(id,organization_id,legal_entity_id,definition,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *", [randomUUID(), org, entity, JSON.stringify(command), user]);
    const response = dto(rows.rows[0]); await audit(client, org, user, "rule.create", response.id, requestId, entity);
    await remember(client, org, user, operation, key, hash, response.id, response); return response;
  });
}

/** Internal read-only diagnostic, not a posting permit or public preview API.
 * Current storage has drafts only. No review/test receipts are fabricated.
 * A financial adapter must eventually lock and load real retained lifecycle
 * evidence in its own posting transaction before it may consume a rule.
 */
export async function checkTaxRuleAvailability(user: string, org: string, entity: string, input: z.input<typeof RuleAvailabilityQuery>) {
  const query = RuleAvailabilityQuery.parse(input);
  return withScope(user, org, entity, "rules.read", async client => {
    const company = await client.query("SELECT policy_status,reporting_profile FROM legal_entities WHERE organization_id=$1 AND id=$2", [org, entity]);
    if (!company.rowCount) throw new DomainError("NOT_FOUND", "Legal entity is unavailable.", 404);
    const rows = await client.query(`SELECT * FROM rule_versions WHERE organization_id=$1 AND legal_entity_id=$2
      AND definition->>'kind'=$3 AND definition->'applicability'->>'event'=$4 AND definition->'applicability'->>'taxCode'=$5
      AND (definition->>'effectiveFrom')::date<=$6::date AND (NOT definition ? 'effectiveTo' OR $6::date<(definition->>'effectiveTo')::date)
      ORDER BY id LIMIT 2`, [org, entity, query.kind, query.event, query.taxCode, query.businessDate]);
    return resolveTaxRule({ ...query, organizationId: org, entityId: entity, companyDemo: company.rows[0].policy_status === "demo" && company.rows[0].reporting_profile === "demo_accrual", now: new Date().toISOString() },
      rows.rows.map(row => { const draft = dto(row); return { record: { id: draft.id, organizationId: draft.organizationId, entityId: draft.entityId, version: draft.version,
        contentHash: draft.contentHash, createdBy: draft.createdBy, createdAt: draft.createdAt, evaluatorVersion: draft.evaluatorVersion, status: draft.status, policy: PolicyDraft.parse(row.definition) } }; }));
  });
}
