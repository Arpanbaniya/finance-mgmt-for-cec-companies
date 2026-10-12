# Statement-local ledger read authorization

## Measured cause and boundary

The refreshed 100,000-line synthetic reporting fixture exposed repeated
membership lookups in the finance reader's row-security predicates. Before
optimization, the actual restricted-runtime statement EXPLAIN ANALYZE took
3,045.962 ms. Its journal-line filter called `finance_setup_scope` and
`can_read_accounts` per row, across 899 journal-index/bitmap iterations.
This is a measured query issue, not a reason to remove row security, cache a
role across requests, elevate the runtime principal or increase request timeouts.

Forward migration 0027 changes only the SELECT policies on journal entries and
lines. Each row still must equal the transaction-local organization and entity.
Given that equality, the existing scope/finance predicates receive those same
IDs through uncorrelated scalar subqueries. PostgreSQL evaluates their InitPlans
once per statement. Membership is checked again for each statement, including
prepared statements; the result is not a process, session or transaction cache.
Empty scope evaluates unavailable; malformed nonempty UUID scope fails closed.
There are no write grants, table-owner changes, raw-owner grants or financial
history changes. Existing posting locks, fresh-cutoff capture, independent
reader authorization and private aggregate-only owner function remain intact.

Plan interpretation follows the official [PostgreSQL EXPLAIN guide](https://www.postgresql.org/docs/18/using-explain.html);
the authorization boundary remains [PostgreSQL row security](https://www.postgresql.org/docs/18/ddl-rowsecurity.html).
The plan output records actual loops and the row filters, not merely estimates.

## Reproducible verification

Run against the dedicated desktop loopback PostgreSQL database:

```sh
pnpm exec tsx scripts/benchmark-subledger.ts --report-plan-only
pnpm exec tsx scripts/benchmark-subledger.ts --public-reports
```

Both runtime and migration URLs must resolve to `127.0.0.1:55432/kaamledger`.
Hosted URLs are rejected before writes. Each run uses unique fictional identities
and organization, creates exactly 100,000 lines through controlled posting
primitives, 500 open items and 200 immutable allocation events. Only that run's
fixture is removed, transactionally restoring append-only guards. Do not run
other database acceptance suites during cleanup or competing builds during
performance sampling. The original `--reports` mode remains available.

Public-report mode tests the strict URL parser and actual authorized `readReport`
adapter. It performs five warmups and 50 measured reads for each of seven cases:
first/deep ledger pages, trial balance, finance P&L/balance sheet and owner
P&L/balance sheet. Samples check exact independent totals, cutoff retention,
bounded row counts and absence of account identifiers in owner payloads. This
excludes HTTP session, network and rendering latency; it is not hosted capacity,
concurrency, arbitrary data growth or complete R1 performance acceptance.

Independent fixture: TB debit/credit 5,010,492.99; assets 5,010,000.00;
liabilities 10,000.00; posted equity 492.99; current result 4,999,507.01;
total equity 5,000,000.00. Explicit revenue is 5,000,000.00 and fixed operating
expense 492.99; gross/contribution profit 5,000,000.00 and net profit
4,999,507.01. The dense expense account has 49,299 lines, closing 492.99,
100-row first page ending 1.00 and middle page 246.50 to 247.50.

Three new actual PostgreSQL cases cover all finance/nonfinance roles with
unfiltered reads, denied mutation grants, same-connection prepared-plan reuse,
same-transaction revocation and restoration, wrong/empty/malformed scope,
transaction-local cleanup and two once-per-statement permission InitPlans for
each journal table with row security still on. The targeted suite passes 31 cases.

## Observed scale run — 12 October 2026

The complete public-report run finished in 149.9 seconds and removed only its
own fixture. Hardware: Windows x64, Intel i7-8550U, eight logical CPUs, 7.9 GiB
RAM, Node 24.19.0 and PostgreSQL 18.4. Each row below has 50 samples after five
warmups, and every result passes the independent expected-number assertions.

| Authorized public adapter read | p95 ms | Maximum ms |
|---|---:|---:|
| Dense ledger first page, 100 rows | 264.352 | 265.398 |
| Dense ledger middle page, 100 rows | 289.366 | 304.512 |
| Trial balance | 278.633 | 433.374 |
| Finance P&L | 325.730 | 516.545 |
| Finance balance sheet | 272.275 | 307.980 |
| Owner P&L | 150.082 | 227.952 |
| Owner balance sheet | 147.835 | 450.644 |

All seven p95 values meet the local bounded-report target of 3,000 ms. The
matching finance statement EXPLAIN executes in 288.914 ms, with four permission
InitPlans each executing once across the two ledger tables; row scope remains
in both filters. The prior 3,045.962 ms plan is a single diagnostic measurement,
not a claimed old 50-run distribution. Subledger ordinary/historical p95 values
are 26.253/17.208 ms. No new index, forced planner setting, permission relaxation
or cross-request result cache was needed. Additional script output/count checks
do not alter the reader or benchmark workloads.

A second complete run of the final harness (including the explicit actual
100,000-row check) passes all 350 measured assertions and cleans its fixture
in 167.5 seconds. Its p95 values in the same table order are 304.941, 299.118,
947.202, 284.767, 278.032, 155.745 and 230.456 ms; every value remains below
3,000 ms. The largest observed report maximum is 1,289.514 ms. The statement
plan takes 303.886 ms with the same four once-only permission InitPlans.
Variation between runs is reported, not concealed or treated as hosted latency.
An independent read-only check confirms all three exact benchmark organizations,
journals, lines and memberships are gone and four checked append-only guards
remain enabled. The persistent local database was not reset.

## Basic-statement acceptance

All 400 local shared tests pass: 191 unit/contracts, 194 actual PostgreSQL/auth,
five private-storage and ten Chromium journeys (1.5 minutes). Lint, typecheck,
40/256 route parity, unchanged generated OpenAPI/catalog, forward migration
replay/restricted grants and the production build (66-second compile) pass.
The browser rechecks real independently approved posting and dated inverse,
report API totals/pagination, finance source/approval drill-down, owner-only
summary navigation/DTO minimization, raw denial and membership revocation.
Finance/owner mobile screenshots were reviewed. No new client cache or visible
workflow is substituted for those server/database checks.

K016's basic four-statement demo boundary is accepted locally, subject to exact
commit CI/publication verification. It does not complete R1. Broader cash-flow/ageing,
forecast/payroll reports, imports, close semantics, the twelve-month workforce
journey and restore/pilot gates belong to their separate R1 tasks. No later
release or live policy is activated by this optimization.
