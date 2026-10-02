# Requirements and traceability

Requirement IDs below freeze all R1 domains. The public API contract is in `docs/contracts/api-catalog.csv`. Later releases stay behind design gates. A requirement's existence does not mean its implementation is complete.

| ID | R1 requirement / reference | Work packages |
|---|---|---|
| R1-SETUP | Repository assessment, frozen scope, reproducible compatible toolchain | K001–K004 |
| R1-ENTITY | Organization/legal-entity/branch, NPR-only, scoped references | K005 |
| R1-IDENTITY | Revocable sessions, finite roles, memberships, field/site access | K006 |
| R1-ISOLATION | Scoped FKs, restricted runtime role, transaction-local RLS | K007 |
| R1-API | Specific REST operations, strict schemas, OpenAPI/parity | K008 |
| R1-VALUES | Exact money, paise allocation, Nepal dates and intervals | K009 |
| R1-APPROVAL | Audit, version/content-bound independent approval | K010 |
| R1-REPLAY | Durable idempotency, source uniqueness, outbox and retry | K011 |
| R1-ACCOUNTS | Chart/control mappings, fiscal periods, numbering | K012 |
| R1-POSTING | Atomic balanced immutable journals | K013–K014 |
| R1-SUBLEDGER | Source-linked open items, allocation history | K015 |
| R1-STATEMENTS | GL, trial balance, profit/loss, balance sheet | K016 |
| R1-PARTIES | Customer/supplier roles and terms | K017 |
| R1-RULES | Verified effective rules and labelled demo profiles | K018 |
| R1-TRADE-DOCS | Invoices, bills, credit notes, source corrections | K019–K020 |
| R1-CASH | Receipts/payments, deposits, withholding, allocations/refunds/bounces/transfers | K021–K022 |
| R1-AGEING | Historical AR/AP ageing and collection notes | K023 |
| R1-EVIDENCE | Private quarantined files, scanning and scoped downloads | K024 |
| R1-EXPENSES | Expense capture, staff advances and reimbursements | K025 |
| R1-BANKING | Statement import/deduplication and exact reconciliation | K026–K027 |
| R1-WORKFORCE | Workers/sites/shifts, independent pay/bill rates, contracts/assignments | K028–K029 |
| R1-ATTENDANCE | Capture/review, independent consumer reservations, delta corrections | K030–K031 |
| R1-ADVANCES | Consented worker advances and capped recovery | K032 |
| R1-PAYROLL | Deterministic pay/YTD calculation, approvals, posting and payment | K033–K034 |
| R1-BILLING | Independent labour billing and reservation-safe invoice drafts | K035 |
| R1-STATUTORY | Reviewed workpaper exports and liability registers | K036 |
| R1-PROFITABILITY | Labour profitability and actual cash flow | K037 |
| R1-FORECAST | Thirteen-week forecast, provenance/replacement/reserve gap | K038 |
| R1-DASHBOARDS | Source-derived owner/finance/site dashboards | K039 |
| R1-IMPORTS | Staged generic imports and authorized exports | K040 |
| R1-CUTOVER | Opening trial balance and exact subledger controls | K041 |
| R1-CLOSE | Month/year locking, retained earnings and reopen | K042 |
| R1-OFFLINE | Attendance/expense drafts, safe sync and conflicts | K043 |
| R1-UX | Responsive accessible English/Nepali interface | K044 |
| R1-DEMO | Service-seeded 120-worker twelve-month demo | K045 |
| R1-ACCEPTANCE | Full attendance-to-cash browser/financial journey | K046 |
| R1-ADVERSARIAL | Concurrency, replay and cross-scope security | K047 |
| R1-RELIABILITY | Job crash handling, performance and restore | K048 |
| R1-DELIVERY | CI/deployment runbook and exact handover | K049–K050 |

## Implemented foundation traceability

| Requirement | API / boundary | Tables/services | Actual tests | Screen |
|---|---|---|---|---|
| R1-SETUP | Local setup/installer, private S3 configuration | scripts/setup-local/install-storage/storage-process; documents/storage-config | unit local-setup/storage-config; real storage authentication/signature/expiry/persistence | infrastructure only; document UI deferred |
| R1-ENTITY | GET/POST org entities, GET/PATCH entity | legal_entities, organizations, branches; platform/service | integration/security; strict platform contracts | workspace |
| R1-IDENTITY | Better Auth allowlisted adapter, GET me, GET/POST/PATCH memberships | auth tables, memberships; identity/auth/session/scope; platform/memberships | integration/authentication/security; browser company-setup grants/edit/conflict/revocation | sign-in, workspace, membership administration |
| R1-ISOLATION | Every entity/membership/policy operation | migrations 0002-security/0003-approval-policies; withScope, composite entity references | runtime nonowner/no BYPASSRLS, unscoped SQL, guessed IDs, pooled reuse, revocation, last admin, direct policy mutation denial | server-enforced |
| R1-API (partial) | Fourteen shipped catalog operations | Zod contracts; generated OpenAPI; route parity | contract/platform/approvals; reference resolution and activation status/header checks | errors and ETags |
| R1-VALUES (started) | Pure domain functions; no posting API yet | domain/money/dates/accounting | unit money/dates/accounting; exact fixture A | no financial screen yet |
| R1-APPROVAL (partial) | Immutable policy create/read/list/activate; scoped metadata audit; protected financial APIs absent | approval_policies/audit_events; domain approval-policy/approvals; features/approvals | unit content/version invalidation, distinct maker-checker, frozen snapshots; contract thresholds/permissions; integration independent activation, overlap races, SQL immutability, legacy audit scope; browser approval-controls | policy register, threshold form, independent activation confirmation/conflict reload, audit filters |
| R1-REPLAY (started) | entity/member/policy creation and policy activation idempotency | idempotency_results; organization locks | concurrent replay, changed-request conflict, original-response replay after edits/activation, revoked reviewer replay denial | stable retry keys in draft and activation forms |
| R1-UX (partial) | Public home/roadmap, secure setup | shadcn components, Next pages | 360px overflow and browser page errors; Nepali DB round trip | home/sign-in/workspace |

No unimplemented domain is marked complete. Financial submission/decision persistence and posting, approval queues, outbox, worker/site scopes and full statutory behavior remain pending. Policy activation is not financial posting or statutory-rule activation. R1-APPROVAL/K010 remain partial until real source documents persist and consume the frozen decisions.
