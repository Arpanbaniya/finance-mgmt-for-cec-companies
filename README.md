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

Open **Approval policies and audit** on a company card to create immutable NPR approval definitions and browse its event history. Thresholds must cover every amount from zero without gaps; the final upper bound is blank. End dates are exclusive. Activation requires a different person with both the **Policy reviewer** role and an administrator or finance manager role. Another administrator must grant that access. Overlapping active policies for the same protected action are rejected; an open-ended active policy cannot be silently replaced. A policy activation does not post money or activate tax rules.

**Your policy notifications** contains private activation alerts delivered to the draft creator. Acknowledge with a short reason; acknowledgement changes only notification metadata, not the policy or any financial document. Reload notifications after a version conflict.

Open **Chart of accounts** on a company card to browse account metadata. Finance managers can create accounts, edit names/parents/report mappings and archive unused accounts with a reason. Account codes are uppercase and unique within a company; codes, types, normal sides and control classifications cannot change after creation. Parent accounts must be active ordinary accounts of the same type. The parent picker shows eligible accounts from the current page; cycles are rejected when saving. Choose **Root account** to clear a parent. Active children must be moved or archived before their parent can be archived. Archived codes stay reserved and all master versions are retained. Accountants and auditors have read-only access. Reload the current account after a version conflict. Account setup does not create balances, post journals or activate statutory policies.

Open **Fiscal calendars and mappings** on a company card to configure an explicit AD fiscal calendar. Supply one to twenty-four ordered, contiguous periods and an active ordinary equity account for retained earnings. End dates are exclusive; calendars cannot overlap and labels are unique within a company. Saved calendars and their retained-account versions are preserved. Each calendar has separate document-number series; numbers are assigned within a posting transaction, not by creating a calendar. Period closing remains under development.

Finance managers can save a complete set of account-purpose mappings with an effective date and reason. Choices are restricted to compatible active account classifications; compatible purposes may share an account. After initial configuration, dates must follow the latest mapping and cannot precede today in Nepal. A future version does not replace today's effective version. Previous mappings and account versions remain preserved. Accounts required by fiscal calendars or current/future mappings cannot be archived. Accountants and auditors may browse setup but cannot change it. Reload current mappings after a version conflict. Mapping tax accounts does not activate statutory rules.

### Manual journal drafts

Open **Manual journal drafts** on a company card to prepare balanced NPR adjustments. Accountants and finance managers can save and edit drafts; auditors have read-only access. Supply posting/document dates, a description and two to five hundred lines. Each line has one positive debit or credit, and totals must match exactly. The server selects current account versions. Control accounts are reserved for their dedicated financial workflows, not ordinary manual journals.

Saved edits retain previous revisions. If another person edits first, reload the current journal before saving again. To cancel an unposted journal, enter a reason and confirm; cancellation preserves its history. Drafts do not allocate a number or affect the ledger.

The original creator can **Submit for review** to freeze the saved content and applicable active journal policy. Only fictional `demo_accrual` company profiles support manual posting. Independent finance managers review the frozen hash, policy version and required approval count. The creator and anyone who previously edited the content cannot approve or reject it. A reviewer can approve once or reject with a reason. Rejection returns the journal to draft; editing a submitted or approved journal also invalidates its submission. Resubmission requires fresh approvals, while earlier snapshots and decisions remain as history.

Once the frozen threshold has enough currently authorized independent reviewers, a finance manager can confirm **Post journal**. Posting rechecks account/policy dependencies and an open fiscal period, then commits the number, exact balanced ledger entry and source history together. Lost-response retries return the committed result without posting again. Posted journals cannot be edited or cancelled. Reload the current journal after a version conflict.

To correct an ordinary posted manual journal, choose **Prepare dated reversal**, enter a posting date and reason, and confirm. This creates a linked draft with exact inverse lines; it does not post money. The date cannot precede the original and must belong to an open period. The original period may be closed when the later reversal period is open. Submit the reversal and obtain fresh independent approvals before confirming its posting. Its creator cannot approve it, and approvals of the original do not carry over.

Reversal dates and inverse lines are fixed. You may edit the description and save to revalidate current accounts; doing so invalidates any submission. Cancel an unposted reversal before requesting a different date. Only one uncancelled request and one posted reversal are permitted per original. Posting the inverse derives the original's **reversed** display state from immutable links, without changing the original ledger or its historical cut-off. Dependent financial/close records block reversal. Reversals of reversals and journal-only reversal of other source types are not supported; their source workflows must handle their dependencies.

The account picker contains eligible accounts from the first hundred chart entries. Branch dimensions supplied through the API must belong to the same company; existing branches are retained when editing. Other dimension types remain unavailable until their scoped masters are implemented.

### Customers and suppliers

Open **Customers and suppliers** on a company card. Finance managers can create
one party with customer, supplier or both roles, edit contact details and future
payment terms, and archive with a reason. Accountants and auditors have read-only
access. Names and nonempty tax identifiers are case-insensitively unique within
a company and remain reserved after archival.

Payment terms are 0–3650 integer days. Customer credit limits use exact NPR
decimal strings; leave blank for no configured limit, or enter zero explicitly.
These are master defaults, not invoice credit enforcement. Bank details are not
accepted on this screen. Reload the current party after a version conflict.

Unresolved balances and unapplied deposits/advances block archival. Settled
parties retain their source references and all master versions. Roles already
used by financial sources cannot be removed; posted documents are never changed
by editing a party. Archived parties cannot be edited or reactivated here.
Select a party and choose **View party statement**. Supply an inclusive as-of
date and an optional start date; blank start includes history from 1900-01-01.
Receivables, payables, customer deposits and supplier advances have separate
opening, movement and closing balances. Ageing uses the posted due dates.
Statements include only committed party-linked sources, not drafts or promises.

**Replay this statement cutoff** preserves the captured knowledge, including
across activity pages. **Run statement** captures fresh knowledge, so later
backdated entries can change the result. Archived parties remain readable.
Source and journal references are shown; invoice/payment source screens remain
unavailable until their dedicated workflows are released. Statements are not
statutory filings or approved close snapshots.

### Financial reports

Open **Financial reports** on a company card. Select profit and loss, balance
sheet, trial balance or an account general ledger. Supply start and exclusive
end dates for interval reports, or an inclusive as-of date for the balance sheet.
Configure the fiscal calendar containing the as-of date first.

Owners receive aggregate profit/loss and balance-sheet summaries. Raw trial
balance and general ledger require finance read access. Trial-balance account
links open the ledger at the same dates and knowledge cutoff; eligible manual
source links lead to their independently authorized journal and approval details.

**Run report** captures fresh knowledge. **Replay this cutoff** and pagination
retain the displayed history. Missing consumed classifications make affected
profit subtotals **Unavailable**, not zero. Comparative and dimensional reports
are not enabled. These temporal reports are not approved close snapshots or
statutory filings.

### Notification delivery

Activation commits a durable event alongside the policy change. An operator runs an explicit scoped batch with restricted runtime credentials:

```sh
# Set OUTBOX_USER_ID to the activating reviewer ID,
# OUTBOX_ORGANIZATION_ID and OUTBOX_ENTITY_ID to the company scope.
# Optional OUTBOX_BATCH_LIMIT: 1–25, default 10.
pnpm outbox:process
```

The reviewer must still have activation authority and company access. The creator must still have policy access. One invocation processes a bounded batch and exits; no scheduler is configured automatically. Expired leases can be reclaimed on the next invocation. Delivery stops after three attempts per cycle. External email and other notification channels are not enabled.

The activating reviewer can open **Delivery job** on their active policy to inspect status, attempts, redacted errors and immutable recovery history. After investigating a failed delivery, enter a recovery reason and confirm **Retry failed job**. Recovery requeues work; an operator must run the scoped worker again. Three manual recovery cycles are permitted, with a maximum of twelve lifetime attempts. Earlier attempts remain recorded. Delivered and cancelled jobs cannot be reopened. Reload current status after a version conflict. Other reviewers and ordinary finance/admin accounts cannot inspect or retry this reviewer's job.

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

`SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` may be stored as optional Data API configuration. The current application does not use that adapter; these values do not enable database access or replace the existing sign-in system. Replace `[YOUR-PASSWORD]` in a provider connection template in a private operator environment, not in source files. Never use the administrator's `postgres` connection as the web runtime connection.

`GROQ_API_KEY` is an optional server-only configuration reserved for future features. Do not prefix it with `NEXT_PUBLIC_`. Configuring it does not enable model calls or change current workflows.

Configure a private S3-compatible bucket with `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY`. Use HTTPS outside loopback development. Do not upload local credentials or service data.

The current application supports company setup, membership administration, approval-policy setup, chart-of-accounts metadata, fiscal calendars, account-purpose mappings, scoped audit browsing and independently approved ordinary manual journals with dated reversal for fictional demo companies. Period closing, payroll, billing and other financial document workflows are under development. Live use requires reviewed company policies and the applicable release acceptance checks.
