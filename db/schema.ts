import { pgTable, text, boolean, timestamp, uuid, integer, bigint, jsonb, date, unique, foreignKey } from "drizzle-orm/pg-core";

// Better Auth owns authentication tables; business authorization is separate.
export const user = pgTable("auth_user", {
  id: text("id").primaryKey(), name: text("name").notNull(), email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false), image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});
export const session = pgTable("auth_session", {
  id: text("id").primaryKey(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(), createdAt: timestamp("created_at", { withTimezone: true }).notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"), userAgent: text("user_agent"), userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" })
});
export const account = pgTable("auth_account", {
  id: text("id").primaryKey(), accountId: text("account_id").notNull(), providerId: text("provider_id").notNull(), userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"), refreshToken: text("refresh_token"), idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }), refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"), password: text("password"), createdAt: timestamp("created_at", { withTimezone: true }).notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});
export const verification = pgTable("auth_verification", {
  id: text("id").primaryKey(), identifier: text("identifier").notNull(), value: text("value").notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});
export const rateLimit = pgTable("auth_rate_limit", { id: text("id").primaryKey(), key: text("key").notNull().unique(), count: integer("count").notNull(), lastRequest: bigint("last_request", { mode: "number" }).notNull() });

export const organizations = pgTable("organizations", { id: uuid("id").primaryKey(), name: text("name").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow() });
export const memberships = pgTable("memberships", {
  id: uuid("id").primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizations.id), userId: text("user_id").notNull().references(() => user.id),
  roles: jsonb("roles").$type<string[]>().notNull(), allowedEntityIds: jsonb("allowed_entity_ids").$type<string[]>().notNull(), siteIds: jsonb("site_ids").$type<string[]>().notNull(),
  active: boolean("active").notNull().default(true), version: integer("version").notNull().default(1), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, t => [unique().on(t.organizationId, t.userId)]);
export const legalEntities = pgTable("legal_entities", {
  id: uuid("id").primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizations.id), name: text("name").notNull(),
  registrationIdentifier: text("registration_identifier"), taxIdentifier: text("tax_identifier"), baseCurrency: text("base_currency").notNull().default("NPR"),
  timezone: text("timezone").notNull().default("Asia/Kathmandu"), activeModes: jsonb("active_modes").$type<string[]>().notNull(),
  reportingProfile: text("reporting_profile").notNull(), policyStatus: text("policy_status").notNull().default("demo"), createdBy: text("created_by").notNull().references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), version: integer("version").notNull().default(1)
}, t => [unique().on(t.organizationId, t.id)]);
export const branches = pgTable("branches", {
  id: uuid("id").primaryKey(), organizationId: uuid("organization_id").notNull(), legalEntityId: uuid("legal_entity_id").notNull(), name: text("name").notNull()
}, t => [foreignKey({ columns: [t.organizationId, t.legalEntityId], foreignColumns: [legalEntities.organizationId, legalEntities.id] })]);
export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey(), organizationId: uuid("organization_id").notNull(), legalEntityId: uuid("legal_entity_id").notNull(),
  code: text("code").notNull(), name: text("name").notNull(), type: text("type").notNull(), normalSide: text("normal_side").notNull(), parentId: uuid("parent_id"),
  isControl: boolean("is_control").notNull(), controlType: text("control_type"), reportSection: text("report_section").notNull(), cashFlowCategory: text("cash_flow_category").notNull(),
  active: boolean("active").notNull().default(true), version: integer("version").notNull().default(1),
  createdBy: text("created_by").notNull().references(() => user.id), updatedBy: text("updated_by").notNull().references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  archivedBy: text("archived_by").references(() => user.id), archivedAt: timestamp("archived_at", { withTimezone: true }), archiveReason: text("archive_reason"),
}, t => [unique().on(t.organizationId, t.legalEntityId, t.id), unique().on(t.organizationId, t.legalEntityId, t.code),
  foreignKey({ columns: [t.organizationId, t.legalEntityId], foreignColumns: [legalEntities.organizationId, legalEntities.id] }),
  foreignKey({ columns: [t.organizationId, t.legalEntityId, t.parentId], foreignColumns: [t.organizationId, t.legalEntityId, t.id] })]);
export const accountVersions = pgTable("account_versions", {
  organizationId: uuid("organization_id").notNull(), legalEntityId: uuid("legal_entity_id").notNull(), accountId: uuid("account_id").notNull(),
  version: integer("version").notNull(), snapshot: jsonb("snapshot").notNull(), recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [unique().on(t.organizationId, t.legalEntityId, t.accountId, t.version), foreignKey({ columns: [t.organizationId, t.legalEntityId, t.accountId], foreignColumns: [accounts.organizationId, accounts.legalEntityId, accounts.id] })]);
export const fiscalYears = pgTable("fiscal_years", {
  id: uuid("id").primaryKey(), organizationId: uuid("organization_id").notNull(), legalEntityId: uuid("legal_entity_id").notNull(), label: text("label").notNull(),
  startDate: date("start_date").notNull(), endDateExclusive: date("end_date_exclusive").notNull(), periodCount: integer("period_count").notNull(),
  retainedEarningsAccountId: uuid("retained_earnings_account_id").notNull(), retainedEarningsAccountVersion: integer("retained_earnings_account_version").notNull(),
  version: integer("version").notNull().default(1), createdBy: text("created_by").notNull().references(() => user.id), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [unique().on(t.organizationId, t.legalEntityId, t.id), foreignKey({ columns: [t.organizationId, t.legalEntityId], foreignColumns: [legalEntities.organizationId, legalEntities.id] }),
  foreignKey({ columns: [t.organizationId, t.legalEntityId, t.retainedEarningsAccountId, t.retainedEarningsAccountVersion], foreignColumns: [accountVersions.organizationId, accountVersions.legalEntityId, accountVersions.accountId, accountVersions.version] })]);
export const fiscalPeriods = pgTable("fiscal_periods", {
  id: uuid("id").primaryKey(), organizationId: uuid("organization_id").notNull(), legalEntityId: uuid("legal_entity_id").notNull(), fiscalYearId: uuid("fiscal_year_id").notNull(), ordinal: integer("ordinal").notNull(),
  startDate: date("start_date").notNull(), endDateExclusive: date("end_date_exclusive").notNull(), state: text("state").notNull().default("open"), version: integer("version").notNull().default(1),
  closedAt: timestamp("closed_at", { withTimezone: true }), closeSnapshotId: uuid("close_snapshot_id"), createdBy: text("created_by").notNull().references(() => user.id), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [unique().on(t.organizationId, t.legalEntityId, t.id), unique().on(t.fiscalYearId, t.ordinal), foreignKey({ columns: [t.organizationId, t.legalEntityId, t.fiscalYearId], foreignColumns: [fiscalYears.organizationId, fiscalYears.legalEntityId, fiscalYears.id] })]);
export const accountPurposes = pgTable("account_purposes", { purpose: text("purpose").primaryKey(), accountType: text("account_type").notNull(), controlType: text("control_type") });
export const accountMappingRevisions = pgTable("account_mapping_revisions", {
  id: uuid("id").primaryKey(), organizationId: uuid("organization_id").notNull(), legalEntityId: uuid("legal_entity_id").notNull(), version: integer("version").notNull(), effectiveFrom: date("effective_from").notNull(),
  reason: text("reason").notNull(), createdBy: text("created_by").notNull().references(() => user.id), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [unique().on(t.organizationId, t.legalEntityId, t.id), unique().on(t.organizationId, t.legalEntityId, t.version), unique().on(t.organizationId, t.legalEntityId, t.effectiveFrom), foreignKey({ columns: [t.organizationId, t.legalEntityId], foreignColumns: [legalEntities.organizationId, legalEntities.id] })]);
export const accountMappingEntries = pgTable("account_mapping_entries", {
  organizationId: uuid("organization_id").notNull(), legalEntityId: uuid("legal_entity_id").notNull(), revisionId: uuid("revision_id").notNull(), purpose: text("purpose").notNull().references(() => accountPurposes.purpose),
  accountId: uuid("account_id").notNull(), accountVersion: integer("account_version").notNull(),
}, t => [unique().on(t.organizationId, t.legalEntityId, t.revisionId, t.purpose), foreignKey({ columns: [t.organizationId, t.legalEntityId, t.revisionId], foreignColumns: [accountMappingRevisions.organizationId, accountMappingRevisions.legalEntityId, accountMappingRevisions.id] }),
  foreignKey({ columns: [t.organizationId, t.legalEntityId, t.accountId, t.accountVersion], foreignColumns: [accountVersions.organizationId, accountVersions.legalEntityId, accountVersions.accountId, accountVersions.version] })]);
export const documentSeries = pgTable("document_series", {
  organizationId: uuid("organization_id").notNull(), legalEntityId: uuid("legal_entity_id").notNull(), fiscalYearId: uuid("fiscal_year_id").notNull(), documentType: text("document_type").notNull(), nextNumber: bigint("next_number", { mode: "bigint" }).notNull().default(1n),
}, t => [unique().on(t.organizationId, t.legalEntityId, t.fiscalYearId, t.documentType), foreignKey({ columns: [t.organizationId, t.legalEntityId, t.fiscalYearId], foreignColumns: [fiscalYears.organizationId, fiscalYears.legalEntityId, fiscalYears.id] })]);
export const documentNumbers = pgTable("document_numbers", {
  id: uuid("id").primaryKey(), organizationId: uuid("organization_id").notNull(), legalEntityId: uuid("legal_entity_id").notNull(), fiscalYearId: uuid("fiscal_year_id").notNull(), documentType: text("document_type").notNull(),
  sourceId: uuid("source_id").notNull(), eventKind: text("event_kind").notNull(), postingDate: date("posting_date").notNull(), sequenceNumber: bigint("sequence_number", { mode: "bigint" }).notNull(), number: text("number").notNull(),
  createdBy: text("created_by").notNull().references(() => user.id), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [unique().on(t.organizationId, t.legalEntityId, t.documentType, t.sourceId, t.eventKind), unique().on(t.organizationId, t.legalEntityId, t.number), foreignKey({ columns: [t.organizationId, t.legalEntityId, t.fiscalYearId, t.documentType], foreignColumns: [documentSeries.organizationId, documentSeries.legalEntityId, documentSeries.fiscalYearId, documentSeries.documentType] })]);
export const approvalPolicies = pgTable("approval_policies", {
  id: uuid("id").primaryKey(), organizationId: uuid("organization_id").notNull(), legalEntityId: uuid("legal_entity_id").notNull(),
  definition: jsonb("definition").notNull(), canonicalPayload: text("canonical_payload").notNull(), contentHash: text("content_hash").notNull(),
  status: text("status").notNull().default("draft"), version: integer("version").notNull().default(1),
  createdBy: text("created_by").notNull().references(() => user.id), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  activatedBy: text("activated_by").references(() => user.id), activatedAt: timestamp("activated_at", { withTimezone: true }), activationReason: text("activation_reason"),
}, t => [unique().on(t.organizationId, t.legalEntityId, t.id), foreignKey({ columns: [t.organizationId, t.legalEntityId], foreignColumns: [legalEntities.organizationId, legalEntities.id] })]);
export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey(), organizationId: uuid("organization_id").notNull(), legalEntityId: uuid("legal_entity_id"), actorId: text("actor_id").notNull(),
  action: text("action").notNull(), targetId: uuid("target_id").notNull(), requestId: text("request_id").notNull(), occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow()
});
export const outboxEvents = pgTable("outbox_events", {
  id: uuid("id").primaryKey(), organizationId: uuid("organization_id").notNull(), legalEntityId: uuid("legal_entity_id").notNull(),
  kind: text("kind").notNull(), policyId: uuid("policy_id").notNull(), sourceVersion: integer("source_version").notNull(), sourceHash: text("source_hash").notNull(),
  principalId: text("principal_id").notNull().references(() => user.id), recipientId: text("recipient_id").notNull().references(() => user.id),
  status: text("status").notNull().default("pending"), attempts: integer("attempts").notNull().default(0), availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  leaseToken: uuid("lease_token"), leaseUntil: timestamp("lease_until", { withTimezone: true }), lastErrorCode: text("last_error_code"),
  version: integer("version").notNull().default(1), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  totalAttempts: integer("total_attempts").notNull().default(0), retryCount: integer("retry_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), completedAt: timestamp("completed_at", { withTimezone: true }),
}, t => [unique().on(t.organizationId, t.legalEntityId, t.id), unique().on(t.organizationId, t.legalEntityId, t.kind, t.policyId, t.sourceVersion),
  foreignKey({ columns: [t.organizationId, t.legalEntityId, t.policyId], foreignColumns: [approvalPolicies.organizationId, approvalPolicies.legalEntityId, approvalPolicies.id] })]);
export const jobRetries = pgTable("job_retries", {
  id: uuid("id").primaryKey(), organizationId: uuid("organization_id").notNull(), legalEntityId: uuid("legal_entity_id").notNull(),
  eventId: uuid("event_id").notNull(), principalId: text("principal_id").notNull().references(() => user.id),
  fromVersion: integer("from_version").notNull(), reason: text("reason").notNull(), requestId: text("request_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [unique().on(t.eventId, t.fromVersion), foreignKey({ columns: [t.organizationId, t.legalEntityId, t.eventId], foreignColumns: [outboxEvents.organizationId, outboxEvents.legalEntityId, outboxEvents.id] })]);
export const alerts = pgTable("alerts", {
  id: uuid("id").primaryKey(), organizationId: uuid("organization_id").notNull(), legalEntityId: uuid("legal_entity_id").notNull(),
  eventId: uuid("event_id").notNull(), effectKey: text("effect_key").notNull(), recipientId: text("recipient_id").notNull().references(() => user.id), policyId: uuid("policy_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  acknowledgementReason: text("acknowledgement_reason"), version: integer("version").notNull().default(1),
}, t => [unique().on(t.eventId, t.effectKey), foreignKey({ columns: [t.organizationId, t.legalEntityId, t.eventId], foreignColumns: [outboxEvents.organizationId, outboxEvents.legalEntityId, outboxEvents.id] }),
  foreignKey({ columns: [t.organizationId, t.legalEntityId, t.policyId], foreignColumns: [approvalPolicies.organizationId, approvalPolicies.legalEntityId, approvalPolicies.id] })]);
export const idempotencyResults = pgTable("idempotency_results", {
  id: uuid("id").primaryKey(), organizationId: uuid("organization_id").notNull(), principalId: text("principal_id").notNull(), operation: text("operation").notNull(), key: text("key").notNull(),
  requestHash: text("request_hash").notNull(), resourceId: uuid("resource_id").notNull(), response: jsonb("response").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, t => [unique().on(t.organizationId, t.principalId, t.operation, t.key)]);
