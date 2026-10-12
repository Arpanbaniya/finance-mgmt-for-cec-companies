# Aggregate-only owner statement boundary

## Scope and authority

R1/K016 remains in progress. This increment supplies an internal entity-summary
reader, not a public dashboard/report route, cash forecast, salary-detail view,
group consolidation or a completed reporting workflow. Finance-only account and
journal RLS policies are unchanged. The owner role already has `dashboard.owner`;
no new role, generic table grant or raw posting permission is introduced.

The service uses authenticated principal scope through `withScope`, transaction-
local settings, and the restricted runtime connection. Forward migration 0026
adds one finite `SECURITY DEFINER` function owned by the migration principal. It
checks exact organization/entity settings, active membership, entity grant and
owner role itself, including a fresh check after acquiring the shared organization
posting/membership lock. Date/knowledge arguments are typed and validated; there
is no dynamic SQL, account/dimension/source filter, cursor or caller-selected
column. Runtime execute is granted explicitly by the migration runner; PUBLIC
execute is revoked in the migration transaction. Relations are schema-qualified
and the fixed search path ends with `pg_temp`.

This follows PostgreSQL's [definer-function guidance](https://www.postgresql.org/docs/current/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY).
As documented for [row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html),
table-owner/migration power is a separate trust boundary. The web runtime remains
a nonowner without superuser or BYPASSRLS privileges. Database credentials and
authenticated-principal installation remain trusted server/operator boundaries;
transaction-local settings are not a substitute for authenticating a user.

## Data minimization and shared calculation

The function first sums posted lines by consumed account version using the same
exclusive business-date, fiscal-year and microsecond knowledge definitions as
the finance reader. It then combines them into finite type/normal-side/statement-
section/P&L-category/cost-behavior buckets. Missing legacy categories remain
unclassified. It checks the 10,000 consumed-version limit and complete retained
version join before returning any totals. No partial report is returned.

Only classification buckets, exact decimal strings and minimal entity/calendar/
policy/cutoff metadata leave this privileged boundary. It returns no real account
ID/name/code/version, journal/source/actor/worker reference, description, private
dimension, journal count, retained-equity account reference or mapping witness.
The finite enum product bounds buckets at 320, independent of ledger line count.
There is one scoped aggregate query, not an N+1 raw-ledger download.

`domain/owner-statements` validates this shape and uses internal synthetic bucket
witnesses to call the existing `calculateStatements` engine. Those witnesses are
not accounts and are never returned. No separate SQL/dashboard profit, tax or
balance-sheet formula is introduced. The strict result exposes only income
movement, classified P&L totals and aggregate balance-sheet figures. It deliberately
does not return the synthetic trial balance or account-level mapping witnesses.

Incomplete classifications preserve unknown/null named profits; missing cost
behavior preserves null contribution. `contributionMappingComplete` indicates
whether both prerequisites are present, without exposing witness identities.
Offsetting debit/credit activity still blocks an unclassified category even when
its net amount is zero. Opening-only categories do not block empty-period income.
Recorded income-tax expense is not a statutory computation. Prior unclosed
results remain separate, and earnings enter equity once through shared arithmetic.

Owners are authorized to view entity-level monetary aggregates. Aggregate-only
access is data minimization, not statistical anonymization: differencing narrowly
chosen dates or a single-entry ledger can reveal an amount. This increment does
not invent suppression/privacy thresholds. No employee/source drill-down follows
from these amounts. Additional payroll/evidence permissions remain necessary.

## Consistency and acceptance

The function waits out in-flight organization-locked postings before capturing a
new knowledge timestamp. Explicit past cutoffs preserve temporal replay, not an
approved K042 durable close snapshot. Service transactions set a two-second lock
timeout and five-second statement timeout. These are execution bounds, not proof
of pilot throughput; the earlier ADR0017 measurements do not certify this reader.

Independent domain/contract cases cover exact fixture totals, unknown mappings,
zero-net activity, opening-only movement, bucket uniqueness/bounds, invalid/private
fields, one-paisa imbalance, huge exact amounts, overflow, empty and contra balances.
Actual restricted-runtime PostgreSQL cases compare owner and finance results,
inspect both database and service payloads for excluded values, prove raw account/
journal reads remain empty, test all other roles/guessed scope/unscoped calls,
revocation/pool cleanup, consumed category changes and pinned knowledge, exclusive
dates/microsecond cutoffs, invalid SQL arguments, function ACL/ownership and temporary
table shadowing. Observed database-lock races prove a waiting read rejects committed
owner-role revocation and includes a preceding committed posting in a new cutoff.

On 12 October 2026 full local verification passed 188 unit/contracts, 188 actual
PostgreSQL/auth, 5 private-storage and 10 Chromium regression tests (391 total),
lint, type checking, forward migration apply/replay, restricted grants, unchanged
39/256 route parity/OpenAPI generation, whitespace checks and production build
(78s compilation/23.9s TypeScript). Eight new PostgreSQL cases and nine new domain/
contract cases cover this boundary. The existing browser suite passed in 1.2m;
no new browser owner journey is claimed because no owner report screen/API has
shipped. Publication evidence remains in the local progress register.

## Remaining work

Concrete catalog report variants/OpenAPI/API/screens, comparative/dimension
contracts, authenticated report journeys and new-reader performance checks remain
before K016 acceptance. K039 complete dashboards, K042 close semantics and the
R1 worker/year/concurrency/restore/live-policy gates are separate tasks. K017 and
later releases have not started. Hosted credentials are not inferred from public
Supabase metadata; this migration is applied only to dedicated local/isolated CI
databases until an operator configures and reviews hosted runtime/migration access.
