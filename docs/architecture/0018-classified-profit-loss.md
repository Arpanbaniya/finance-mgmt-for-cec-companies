# Retained P&L classifications

## Boundary

R1/K016 remains in progress. This increment extends the existing catalog account
create/edit/read operations with explicit P&L and cost-behavior metadata, and the
internal finance-reader statement service with classified subtotals. No report
endpoint, owner raw-ledger grant, tax computation or later-release module ships.
README and the original route inventory remain unchanged.

## Classification and history

`reportMapping.profitLossCategory` is finite: unclassified, not applicable,
operating revenue, direct cost, operating expense, other income, finance cost or
income-tax expense. Categories must match immutable account type. Fixed/variable
behavior is permitted only for direct/operating costs; unclassified/not applicable
does not establish behavior for contribution analysis. This is company-selected
management presentation, not a certified accounting-framework or tax policy.
Neither names/codes nor statutory-payable/output-tax accounts imply an expense.

Forward migration 0025 adds two metadata columns with database constraints. The
existing account guard is preserved except for admitting these two fields in an
authorized versioned edit. Archived identity/classification, hierarchy, actor and
scope protections remain. Database-owned version snapshots capture new choices;
no old snapshot or posted journal is rewritten or backfilled. Legacy missing
snapshot keys mean unclassified. Legacy PATCH clients omitting these new choices
preserve them; an explicit unclassified value can clear a future classification.
Name-only edits preserve both choices. Changes still invalidate account-version
dependencies of unposted approvals through existing controls.

The reporting query groups actual posted lines by consumed account version. Each
version keeps its category, even if a newer version puts subsequent costs into a
different section. Chart edits without new postings cannot retag old movement or
change a historical cutoff replay. Existing fiscal/knowledge/retained-version/RLS
bounds remain. Metadata advances to `statement-foundation-v2`.

## Exact presentation

Revenue is credit minus debit; expense is debit minus credit, including contra
movements and credits with real signs. Subtotals are decimal strings:

- Gross profit = operating revenue − direct costs.
- Operating profit = gross profit − operating expenses.
- Profit before tax = operating profit + other income − finance costs.
- Net profit = profit before tax − recorded income-tax expense.
- Contribution margin = operating revenue − variable direct/operating costs.

When categories are complete, net profit must equal the existing ledger income
movement exactly; current-year earnings and balance-sheet arithmetic stay shared.
Income-tax expense is only recorded movement, not taxable profit, a guessed rate,
assessed liability or filing. Closing-entry exclusion and certified year-close
semantics remain K042 work.

Any revenue/expense version with period debit or credit needs classification,
including offsetting zero-net activity. Incomplete categories leave all named
profit subtotals null, retain known classified components and unclassified
revenue/expense totals, and identify bounded account/version witnesses. An exact
overall movement is not relabelled as verified net profit. Missing fixed/variable
behavior independently makes contribution null; otherwise classified gross,
operating/pre-tax/net profit remain available. Opening-only/unused accounts do
not block a genuinely empty period. No variable-cost percentage is guessed.

## User flow and evidence

Finance managers use labelled chart-of-accounts category/behavior selectors.
Incompatible categories are not offered; account-type changes reset new choices,
and category changes reset behavior. Current metadata is visible to authorized
readers. Save uses existing version/permission/error handling; stale-form keys,
parallel scoped server reads and existing audit/version machinery are preserved.
All financial calculations remain outside React.

Nine independent domain cases cover 1,000.00 revenue, 400.00 direct costs, 250.00
operating expenses, 20.00 other income, 30.00 finance cost, 40.00 tax expense:
gross 600.00, contribution 650.00, operating 350.00, pre-tax 340.00, net 300.00.
They also cover legacy/incomplete and zero-net classification, missing behavior,
consumed-version splits, contra/loss signs, paise beyond safe numeric integers,
invalid mappings and empty periods. The added contract case proves finite
compatible choices and legacy PATCH omission without guessed defaults.

Four actual PostgreSQL cases prove retained metadata across versions, compatible
runtime SQL constraints/unversioned rejection, legacy historical incompleteness,
and direct-cost/operating-cost splits after two postings plus pinned cutoff replay.
The targeted account/statement suite passed 31 tests. Full local verification on
12 October 2026 passed lint, type checking, 179 unit/contracts, 180 PostgreSQL/auth,
5 real private-storage and 10 Chromium tests (374 total), migration apply/replay,
restricted-grant checks, OpenAPI regeneration, unchanged 39/256 route parity,
whitespace checks and the production build (80s compilation/9.6s TypeScript).
The new browser story verifies create/reload/category edit through actual API and
retained database versions; its 360px screenshot was inspected without overflow.
The browser suite passed in 1.4 minutes. Local server output also contained the
previously observed destination-stream cancellation message; these successful
assertions do not claim entirely empty local stderr. Hosted financial acceptance
is not established by local tests or a public-shell deployment.

## Remaining K016 work

Aggregate-only owner reporting requires a separately reviewed database boundary;
no owner account/journal RLS is widened here. Concrete report variants, authorized
public routes/screens, comparative/dimension decisions and full report journeys
remain before task completion. Prior ADR0017 performance measurements apply to
the earlier reader and are not a fresh throughput guarantee for this increment.
Full R1 worker/year/concurrency/restore/pilot gates remain separate; no K017/R2+.
