# Financial report API and screens

## Delivered slice

R1/K016's existing finite catalog `GET /reports/{reportType}` now exposes four
concrete variants: trial balance, account general ledger, profit and loss, and
balance sheet. The original catalog remains unchanged; route parity advances
from 39 to 40 implemented operations out of 256. Cash flow, ageing, profitability,
payroll/advance/statutory summaries, exports and dashboards remain separate work.
There is no arbitrary table/controller dispatch or placeholder monetary result.

Routes authenticate the actual session, validate the path and strict URL fields,
then call `features/reporting/report-service`. Pages call the same authorized
service, not another calculator. `reports.read` is required for all variants.
Trial balance/general ledger additionally require current finance-ledger authority;
owner-only P&L/balance sheet use the aggregate database boundary from ADR0019.
An owner with an additional finance role may use the finance view only while that
role remains authorized. Each reader rechecks membership/entity/permissions after
the adapter's initial view selection, including each pagination request.

All responses pass concrete strict Zod DTO validation and use the standard
request-ID envelope and private/no-store headers. No cached private report or
salary/evidence access is introduced. Aggregate statements omit account/journal/
worker references, mapping witnesses and retained-equity account metadata even
for the finance summary view. Finance can inspect actual accounts through trial
balance and actual source links through the bounded general ledger instead.

## Filters and replay

Trial balance, general ledger and P&L require explicit `fromDate` and
`toDateExclusive`. Balance sheet requires inclusive `asOfDate`, with the next
exclusive date calculated in the service; it summarizes books from the supported
1900 lower bound and uses the configured fiscal year for current-year results.
The final representable inclusive date is 9999-12-30. No July fiscal-year dates,
BS conversion, closing-entry exclusion or tax rates are inferred.

`knownAt` retains six fractional UTC digits. Omission captures new knowledge after
the posting lock; supplying it replays the temporal cutoff, not a durable close
snapshot. Only general ledger accepts an account filter. Only trial balance and
general ledger accept a bounded limit (default 25, maximum 100) and cursor.
Repeated URL keys, path-type overrides, numeric ambiguities, unrecognized fields
and incompatible report filters fail explicitly. Dimensional filters are rejected.
`includeComparative=false` is the current contract; true and catalogued deferred
report types return `FEATURE_NOT_ENABLED` after scope authorization. The finite
path enum is a string, not a UUID; generated OpenAPI records conditional query
requirements and four named response shapes instead of arbitrary JSON.

Trial balance computes whole-report exact totals before returning at most 100
account rows. Its canonical bounded cursor binds organization/entity/dates/cutoff
and a real account anchor. Every page recomputes the retained-version statement,
checks the anchor, inherits the cutoff and reauthorizes. It contains no money or
permission assertion. Totals are for the entire report, not only the visible page.
The internal 10,000 retained-version bound remains fail-closed rather than silently
truncating financial sums. Account order remains stable code/ID order. The general
ledger retains ADR0017's scoped source/version/position/cutoff/anchor controls.

## Interface

Company cards expose Financial reports only to current report-capable roles.
The server-rendered reports page offers only supported and permitted variants.
Labelled GET forms, initial empty prompt, missing-calendar/validation messages,
real empty-ledger states, cutoff replay and next-page links retain scope. Submitting
Run report captures fresh knowledge; replay/pagination/drill-down keep the displayed
cutoff. Independent entity/access reads run in parallel. No new client-side cache,
salary serialization, duplicated finance arithmetic or broad client report state
is introduced. Money is displayed from exact decimal strings, never through Number.

P&L distinguishes gross/contribution/operating/pre-tax/net figures and recorded tax
expense. Missing consumed classifications or cost behavior display Unavailable,
not zero; overall income movement is not relabelled as classified net profit.
Balance sheet separates posted equity, current-year and prior unclosed results.
Trial-balance account links open its ledger at identical dates/knowledge. Only a
real posted manual-source binding offers the independently authorized existing
journal/approval detail; no invented source/evidence URL is offered. Unavailable
workflows and remaining report exclusions are visible. At mobile width, account
balance bases and ledger entries use compact cards instead of a wide spreadsheet.

## Acceptance and remaining gates

Three new contract cases cover report-specific fields, strict URL coercion/repeated
keys and concrete OpenAPI/path/response variants. Three actual runtime PostgreSQL
cases cover whole-report totals across all nine accounts paged two at a time,
cutoff inheritance/real-anchor/context/revocation, owner summary minimization versus
raw denial, shared finance/owner arithmetic, and explicit deferred-capability scope
errors. The targeted statement suite passes 28 tests; full unit/contracts and full
PostgreSQL/auth each pass 191 tests. Existing journal browser acceptance is extended
to use its actual independently approved original and dated inverse for report API,
finance drill-down, exact posted ties and owner denial/revocation/mobile journeys.
All 397 local checks pass: 191 unit/contracts, 191 PostgreSQL/auth, five real
private-storage checks and ten Chromium journeys (1.7 minutes). The browser
journey verifies report totals against the actual posted original and inverse,
trial-balance pagination, finance source drill-down, owner-only navigation and
DTO minimization, raw-report denial and next-request membership revocation.
The 360px finance/owner screens were visually reviewed without overflow.
Lint, typecheck, route parity, migration/grant replay, generated OpenAPI and
production build pass. Exact-commit CI and deployment evidence is maintained
in the local progress register after publication; these local checks do not
claim hosted financial acceptance.

The interface slice is locally accepted; K016/R1 remains in progress pending
fresh reader-scale verification. Earlier ADR0017 timing is not a throughput guarantee
for the new classified/owner/public adapter. Comparative/dimensional reporting is
explicitly unavailable, not implied by a checkbox. K042 close/retained-earnings
semantics and K045–K048 full labour-year/performance/restore/replay gates remain
separate. Later releases have not begun. Public deployment does not enable hosted
financial use while operator-provisioned restricted database credentials are absent.
