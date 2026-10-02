import { pgTable, text, boolean, timestamp, uuid, integer, bigint, jsonb, unique, foreignKey } from "drizzle-orm/pg-core";

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
export const idempotencyResults = pgTable("idempotency_results", {
  id: uuid("id").primaryKey(), organizationId: uuid("organization_id").notNull(), principalId: text("principal_id").notNull(), operation: text("operation").notNull(), key: text("key").notNull(),
  requestHash: text("request_hash").notNull(), resourceId: uuid("resource_id").notNull(), response: jsonb("response").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, t => [unique().on(t.organizationId, t.principalId, t.operation, t.key)]);
