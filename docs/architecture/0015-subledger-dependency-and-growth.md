# Subledger dependency clearing and history growth

## Dependency contract

`app_security.require_journal_dependencies_clear(org, entity, journal, posting)` is an owner-only shared gate, not a posting command or approval. It locks the organization, verifies current finance-read visibility and rejects missing/out-of-scope journals. Direct web-role execution remains withheld. The calling workflow still owns its action permission, version, maker-checker, open-period and source-content checks. Finance-read scope preserves existing accountant inverse-description editing; it does not grant approval or posting.

The gate fails when any matching hold lacks a complete, scoped allocation-inverse release effective on or before the proposed correction date. A release for `allocation` cannot clear a `payment`, `reconciliation` or `close` hold, even when dependency IDs collide. Clearing one of several allocations does not clear another. Holds and releases remain immutable.

Ordinary-manual inverse body validation checks the actual requested posting date and is invoked again by final ledger insertion. An allocation inverse performs a deferred check against its original application journal after its own releases exist; another dependency makes the entire inverse roll back. Organization serialization prevents a competing dependency/inverse pair from both succeeding. Once the inverse exists, same-transaction and later hold insertion is rejected. No source-document reversal API or generic runtime dependency API is introduced.

## Historical consistency optimization

Migration0023 retains the complete date/knowledge rectangle invariant. For each target/capacity book and knowledge instant, it groups visible signed allocation effects by business date and checks running balances against zero and the exact original limit. This replaces the previous three-way date × knowledge × event expansion; it does not merely check today's balance, or assume system clocks are monotonic. Scoped predicates use the existing target/capacity cutoff indexes.

Real PostgreSQL tests compare the window result with independent direct rectangle sums on valid histories, on an invalid backdated application before commit, and after a valid later reuse. Invalid history still raises `OVER_ALLOCATION` and leaves no source receipt. Existing source/target race, microsecond visibility, inverse contra-line and rollback tests remain required.

## Reproducible local benchmark

Run `pnpm exec tsx scripts/benchmark-subledger.ts` with the dedicated local PostgreSQL service. Both database connections must identify `127.0.0.1:55432/kaamledger`; other targets fail before writes. It creates a unique synthetic organization and verified test identity, uses accounting services/private fixture primitives to build balanced journals, and removes only that run's rows in `finally`. It neither resets a database nor disables posting guards to seed money. Cleanup restores append-only guards after deferred checks.

Dataset: exactly 100,000 journal lines, 500 AR origins, one deposit and 200 immutable application/inverse events on one growing history. Ordinary journal padding uses balanced, exact two-sided line groups of at most 500 lines. All source effects, numbers, audits and events come from posting primitives, not fabricated totals or bulk inserts into the ledger. This is a trusted synthetic kernel benchmark, not a company approval workflow or the future 120-worker demo seed.

Hardware: Windows x64, Intel Core i7-8550U 1.80GHz, eight logical CPUs, 7.9 GiB RAM, Node24.19.0, PostgreSQL18.4. Measurements are end-to-end service/transaction times on this host, not Vercel results. Each ordinary warm read measurement uses five warmups and 50 runs, page limit100. All 500 origins are also traversed without duplicate/missing cursors and checked against independently expected decimal balances. The refined benchmark additionally measures 50 historical reads on a page guaranteed to contain the grown history, immediately before its final business-date inverse.

| Measurement | Original rectangle join | Grouped running sums |
|---|---:|---:|
| First25 application+inverse cycles, p95 | 100.194ms | 37.983ms |
| Last25 cycles, p95 | 6922.560ms | 691.098ms |
| 50 ordinary warm page reads, p95 | 22.167ms | 23.364ms |
| Whole fixture/check run | 221.31s | 90.27s |

The paired measurements used the same dataset/service workload. Query plans limited the origin page to101 rows; they scanned500 scoped origins and200 allocations, with no journal-line scan or join despite the100,000-line ledger. PostgreSQL selected sequential scans for these small scoped tables; indexes were not forced to manufacture a favorable plan. The query is shared with the reader so diagnostics do not test a separate SQL calculator.

The final refined run recreated the same100,000-line/500-origin/200-event fixture:50ordinary reads p95=23.890ms/max25.536ms and50historical page reads p95=14.815ms. The historical page was guaranteed to include the grown item and independently reconstructed allocated0.01/outstanding9999.99 immediately before its final inverse; later visibility returns10000.00. Both measured read targets were below1s. First/last25cycle p95=29.616/356.788ms; total99.27s including extra historical checks. A production build ran concurrently, so these local observations should not be treated as controlled hardware capacity or a stronger universal latency guarantee. All three runs cleaned their own fixture and restored guards; no benchmark rows remain.

These results demonstrate a bounded K015 foundation workload and an observed history-growth improvement. They do not certify arbitrary history lengths, hosted/pilot performance, later reports/exports, the twelve-month workforce seed or the complete R1 performance/restore gates. Repeat on representative pilot data before activation. No production credential, hosted migration or paid resource is provisioned by the benchmark.

## Acceptance status

K015's internal foundation is accepted on11October2026:325unique passing tests (150unit/contracts,161real PostgreSQL/auth,five real storage,nine Chromium), including34targeted dependency/history/manual-reversal regressions. Lint/typecheck, migration apply/replay, unchanged39/256catalog parity/OpenAPI/original catalog hash, whitespace and final production build passed. The nine-story browser suite passed58s, including actual persisted journal posting and fresh independently approved dated reversal. The benchmark above exercised real100,000-line storage and bounded historical reads without bypassing posting guards.

Acceptance is for source-linked primitives, reproducible dual-cutoff balances, enforced journal links, controlled dependency lifecycle and the measured foundation workload—not activated trade/cash/party/opening workflows or the full R1 release. Publishing/CI/hosted smoke evidence is tracked separately. K016 is the next task within R1; no later release has started. Original source-specification status fields remain preserved; current implementation state belongs in the engineering registers.
