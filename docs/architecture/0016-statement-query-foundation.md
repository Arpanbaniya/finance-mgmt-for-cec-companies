# Statement query foundation

## Boundary

R1/K016 is in progress. This increment is an internal finance-reader foundation,
not a shipped report API or report screen. No catalog operation, public response
contract, runtime database grant, posting workflow or applied migration changes.
`readStatementFoundation` reads the actual posted ledger through transaction-local
scope and the restricted runtime role. Owner, administration and site roles do not
gain raw-ledger access. Aggregate-only owner access needs its own reviewed boundary
before the public report operation ships.

## Exact calculations

One scoped PostgreSQL aggregate scan collects opening, period and configured
fiscal-year movements by retained account version. The service returns only named
account metadata and decimal strings; no header payloads, actors, private dimensions
or source descriptions. Account names and sections come from the versions consumed
by journal lines, not today's mutable chart. Versions are grouped into one account
before debit/credit closing balances are split. Rows identify the consumed versions.

Trial balance proves opening balance plus debit-minus-credit period movement equals
closing, with exact opening/movement/closing debit and credit totals. Income movement
is revenue minus expenses. Current mappings do not distinguish direct costs,
operating costs or income-tax expense: this result is not labelled gross margin,
operating profit, pre-tax profit or a complete P&L.

Balance-sheet equality uses signed assets, liabilities and posted equity. The
remaining revenue/expense balance is split into current fiscal-year result and
prior unclosed result. Those two amounts enter equity once. A transfer already
included in equity leaves no residual income to add a second time. This arithmetic
does not implement or certify the future approved year-close source, historical
P&L exclusion of closing entries, or reopening/reclosing. Prior unclosed result is
visible, not silently called retained earnings.

## Cutoffs and bounds

Dates are explicit `[fromDate,toDateExclusive)` AD dates. As-of is the day before
the exclusive end. The configured fiscal year containing that day is required;
there is no guessed Nepal calendar. The inclusive knowledge timestamp retains six
UTC fractional digits. New cutoffs are captured after acquiring the same scoped
organization lock used by posters, so an in-flight posting cannot acquire an old
recorded timestamp and commit after that initial read. Backdated later postings do
not enter an earlier retained cutoff. Future knowledge cutoffs are rejected.

Metadata includes organization/entity, NPR, interval/as-of, exact generation and
knowledge instants, latest visible recorded instant, visible journal count,
configured fiscal year/retained-earnings reference, current entity reporting profile
and policy status, retained mapping basis, and calculator version. Entity profile
metadata is observed configuration, not a certified historical policy snapshot.
Timestamp cutoffs are temporal queries, not durable approved close snapshots; K042
must retain its ledger membership/hashes and address clock changes and subsequent
reopening semantics.

The application receives account aggregates, not the full journal history. At most
10,000 retained account/version aggregates are accepted. A 10,001st aggregate fails
the report rather than returning partial totals. A missing retained version or
overflow also fails closed. A 2-second lock wait and 5-second per-statement timeout
bound this internal request; performance targets are not implied by those limits.
The organization lock serializes these reads with writers, which requires measured
query-plan/latency evaluation before shipping a high-traffic public report.

## Evidence and remaining acceptance

`tests/unit/statements.test.ts`: ten independent exact-money checks, including the
nine-account numeric fixture (TB 137,500.00; result 10,300.00; assets 114,800.00;
liabilities 4,500.00; equity 110,300.00), prior results, version netting, transfer
arithmetic, losses, one-paisa failure, invalid mappings, unsafe-number-range paise,
overflow, strict dates/instants and empty results.

`tests/integration/statements.test.ts`: ten actual local PostgreSQL checks for those
numeric ties, exclusive date/opening semantics, finance/owner/admin/site permissions,
unavailable fiscal calendar/future cutoff/query escape rejection, genuinely empty
versus denied entity, one-microsecond inclusion boundary, backdated historical replay,
retained names/version netting, revocation/unscoped pooled reads and observed
in-flight posting lock/commit/cutoff replay. The nine-account seed is one privileged
ordinary-journal test fixture. It does not seed or accept payroll, trade documents,
control subledgers, cash or opening-import workflows. Setup uses services/private
test posting primitives, not disabled guards. Cleanup removes only the unique local
fixture and restores its append-only triggers transactionally.

General-ledger pagination/source-reference evidence is recorded in ADR0017.
Before K016 acceptance: public authorized drill-down/report journeys;
explicit direct/operating/tax report mappings; owner aggregate-only permission path;
concrete catalog/OpenAPI report variants with deferred types rejected; screens and
browser journeys; actual control-source fixtures; comparative/dimension capability
decisions; measured report queries on the separate 100,000-line dataset; shared
regression gates. K017 and later releases have not started.

Local shared verification on 11 October 2026: lint, typechecking, 160 unit/contract
checks, 171 PostgreSQL/auth checks, migration replay/restricted grants, OpenAPI
generation, 39/256 route parity and whitespace checks passed. No catalog/README
changes. Full report-performance, browser report journeys and hosted authenticated
financial acceptance are not claimed by these foundation checks.
