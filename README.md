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

Configure a private S3-compatible bucket with `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY`. Use HTTPS outside loopback development. Do not upload local credentials or service data.

The current application supports company setup. Accounting, payroll, billing and document workflows are under development. Live use requires reviewed company policies and the applicable release acceptance checks.
