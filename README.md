# KaamLedger

Finance and workforce operations for companies in Nepal.

## Requirements

Node.js 24 and pnpm 11.19.0. Local services use PostgreSQL and private S3-compatible storage. No Docker or paid account is required on Windows x64 or Linux x64.

## Development

```sh
pnpm install --frozen-lockfile
pnpm setup:local
pnpm storage:install
pnpm services:up
```

Keep PostgreSQL running. In separate terminals, start storage and the application:

```sh
pnpm storage:up
```

```sh
pnpm db:migrate
pnpm dev
```

Open http://localhost:3000. Generated credentials and service data remain in ignored `.env.local` and `.local/` files. Re-running setup preserves existing credentials.

To create the initial organization administrator, set `BOOTSTRAP_EMAIL` and `BOOTSTRAP_PASSWORD` in your process environment, then run `pnpm bootstrap:admin`. Passwords must contain at least 14 characters. Optionally set `BOOTSTRAP_ORGANIZATION`. Public signup is disabled. Organization administration does not grant financial approval.

## Usage

Sign in with an operator-provisioned account and select an organization. Organization administrators can create and edit legal entities from the company workspace.

Use **Manage memberships** to assign an existing verified user ID, roles and visible legal-entity grants. Accounts are provisioned separately; no invitation is sent. Another administrator must change your own access. Revoking a membership blocks organization access on the next authorized request and retains history. If an edit conflicts with a newer version, reload current memberships before retrying.

Open **Approval policies and audit** on a company card to create immutable NPR approval definitions and browse its event history. Thresholds must cover every amount from zero without gaps; the final upper bound is blank. End dates are exclusive. Activation requires a different person with both the **Policy reviewer** role and an administrator or finance manager role. Another administrator must grant that access. Overlapping active policies for the same protected action are rejected; an open-ended active policy cannot be silently replaced. A policy activation does not post money or activate tax rules. Financial document submissions remain under development.

**Your policy notifications** contains private activation alerts delivered to the draft creator. Acknowledge with a short reason; acknowledgement changes only notification metadata, not the policy or any financial document. Reload notifications after a version conflict.

### Notification delivery

Activation commits a durable event alongside the policy change. An operator runs an explicit scoped batch with restricted runtime credentials:

```sh
# Set OUTBOX_USER_ID to the activating reviewer ID,
# OUTBOX_ORGANIZATION_ID and OUTBOX_ENTITY_ID to the company scope.
# Optional OUTBOX_BATCH_LIMIT: 1–25, default 10.
pnpm outbox:process
```

The reviewer must still have activation authority and company access. The creator must still have policy access. One invocation processes a bounded batch and exits; no scheduler is configured automatically. Expired leases can be reclaimed on the next invocation. Delivery stops after three attempts; failed events require operator investigation. External email and other notification channels are not enabled.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:storage
pnpm route-parity
pnpm api:generate
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

Database tests use the dedicated local database. Browser tests require the application running at localhost:3000. Storage tests start an isolated instance and verify authentication and persistence.

## Deployment

The web application runs on Vercel. Configure a hosted PostgreSQL database using restricted runtime credentials, `DATABASE_URL`, `BETTER_AUTH_SECRET`, and `BETTER_AUTH_URL`. Apply migrations with separate administrator credentials; never include `MIGRATION_DATABASE_URL` in the web deployment.

For Supabase, set `SUPABASE_PROJECT_REF` and obtain connection details from the project's **Connect** panel. Create the restricted `kaamledger_app` PostgreSQL role through the migration setup. For the runtime transaction pooler, use its host/port and the username `kaamledger_app.<project-reference>`, not `postgres.<project-reference>`. Direct connections use `kaamledger_app`. Use a separate direct or session-pooler administrator connection for migrations. Use verified TLS and the provider's certificate configuration. The application uses PostgreSQL and its existing session authentication; a Supabase public/service API key is not a substitute for `DATABASE_URL`.

Keep the hosted URLs in a separate deployment/operator environment. Do not replace `.env.local` with hosted credentials before running database or browser tests. Apply migrations and provision the administrator before using hosted sign-in.

`GROQ_API_KEY` is an optional server-only configuration reserved for future features. Do not prefix it with `NEXT_PUBLIC_`. Configuring it does not enable model calls or change current workflows.

Configure a private S3-compatible bucket with `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY`. Use HTTPS outside loopback development. Do not upload local credentials or service data.

The current application supports company setup, membership administration, approval-policy setup and scoped audit browsing. Accounting, payroll, billing and financial document workflows are under development. Live use requires reviewed company policies and the applicable release acceptance checks.
