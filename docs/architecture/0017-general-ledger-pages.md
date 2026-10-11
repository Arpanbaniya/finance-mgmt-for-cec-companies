# Bounded general-ledger pages

## R1 boundary

K016 remains in progress. `readGeneralLedger` is an internal finance-reader service,
not a new public report route or UI. It shares the existing statement reader's
transaction-local runtime scope, finance permission check, organization posting
lock and bounded timeouts. Owner/admin/site roles do not gain raw-ledger access.
No posting grant, account/ledger history mutation or applied migration changes.

## Query and response contract

Select one scoped account, explicit `[fromDate,toDateExclusive)` AD interval, optional
normalized UTC microsecond `knownAt`, limit 1–100 (default 25), and optional cursor.
The configured fiscal year containing the as-of day is required. SQL aggregates
the selected account in PostgreSQL, selects at most 101 candidate lines, and returns
at most 100 rows. No full-ledger payload reaches the application and no per-row
application queries are made.

The response has concrete strict schemas for account identity, report metadata,
lines, totals and page state. It includes exact opening/period/closing amounts,
line count, server-recomputed preceding-page balance and each running balance.
Balances are explicitly debit-positive, including credit-normal accounts. Money
is always a decimal string. Overflow, unavailable scope, invalid cursor, future
knowledge and missing retained versions fail closed, not as fabricated zero totals.

Each row retains its own posted account version/name. The header uses the highest
account version actually consumed by visible postings, or the initial version for
an unused account. Unused later chart edits cannot change historical page labels.
Account creation's guarded recorded clock determines availability at a cutoff;
account-version transaction-start timestamps do not masquerade as a consumed label.

Metadata retains NPR/entity, interval/as-of, generated/known-at clocks, configured
fiscal year and retained-equity reference, current observed entity policy/profile,
report/mapping versions, balance convention and watermark scope. In this account
report, watermark and journal count describe the selected account, explicitly—not
the entity-wide report. Timestamp replay is not a durable approved close snapshot.

## Cursor and authorization

Stable order is `(posting_date,journal_id,ordinal)`. The versioned base64url cursor
binds organization/entity/account/interval/knowledge and a line position. It carries
no money, actor, role or private payload. It is an encoding, not a credential or
signature: every request reauthorizes scope and verifies the anchor against actual
visible account lines. A forged/nonexistent position or changed context is rejected.
Changing the bounded page size is allowed. A cursor's cutoff is inherited when not
repeated, and must match if repeated. Server-side prefix sums do not trust a client
running balance. Later backdated postings remain outside earlier page knowledge.

Only a real posted manual draft whose scoped ID, source ID and posted journal ID
agree gets `manualJournalId`. It uses the existing catalog journal detail operation,
which independently rechecks `journals.read` and returns its retained approval
review. The reference grants no authority. Details are a current authorized read,
not a claim of historical approval eligibility at the report timestamp. Privileged
primitive fixtures without a draft get null; invoice/settlement primitives also get
null rather than invented detail/evidence URLs. Private worker/candidate dimensions,
actors, header descriptions and source payloads are not returned by this reader.
Future sensitive source kinds require an explicit underlying-data permission gate.

## Acceptance evidence

- Nine domain/cursor tests: exact prefix/contra balances, paise beyond safe numeric
  integers, overflow, distinct stable positions, one-sided lines, source agreement,
  scoped microsecond cursor roundtrip, changed context/malformed encodings/extra
  fields, strict bounds and empty pages.
- Five new actual PostgreSQL cases in `integration/statements`: account totals and
  opening-only/credit account reads; 130 repeated account lines in a balanced journal
  across six pages with independent expected balances and no duplicates; replay
  after a new backdated posting and unused metadata edit; actual-anchor/context/
  entity/role/future rejection; microsecond inclusivity and revoked cursor access.
- Existing actual manual lifecycle test now follows a proven ledger reference through
  authorized journal detail and verifies its two independent approvals.
- Existing actual subledger test now ties an invoice/deposit application to AR debit
  3,000.00/credit 3,000.00/closing zero; no manual detail links. Its statement has
  assets 5,000.00 = liabilities 2,000.00 + equity/current result 3,000.00. This tests
  the private controlled producer, not acceptance of future public trade workflows.

The full local source gates passed lint, type checking, 169 unit/contract tests,
176 PostgreSQL/authentication tests, migration replay/restricted-grant verification,
OpenAPI regeneration without an artifact change, route parity (39/256), whitespace
checks and the production build. An initial database run concurrent with the build
timed out in authentication setup (172 passed, four skipped); the unchanged full
sequential rerun passed all 176. No timeout or runtime authorization was relaxed.
The public report route/screens remain unimplemented, so these checks are not
browser acceptance of a general-ledger screen or hosted financial use.

## Reproducible performance check

Run `pnpm exec tsx scripts/benchmark-subledger.ts --reports` against the dedicated
desktop loopback database only. The default subledger benchmark remains available.
The optional reporting mode adds five warmups then 50 reads each for first/middle
pages of a dense 49,299-line account and complete statement aggregates, all on the
same exactly 100,000-line/500-origin/200-allocation-event fixture.

Independent dense-account debit/closing is 492.99. First page runs from 0.00 to 1.00;
middle page runs from 246.50 to 247.50. Independent statement TB is 5,010,492.99 each
side; assets 5,010,000.00; liabilities 10,000.00; equity 5,000,000.00; current result
4,999,507.01. EXPLAIN ANALYZE uses the same service SQL and restricted runtime scope,
not a duplicate query or forced index. Hardware, actual distributions and plan
footprints are emitted. The unique synthetic fixture is removed transactionally
and guards restored, without resetting user data or a hosted database.

Measurements are observations, not vendor or production guarantees. The remaining
120-worker/12-month journey, pilot concurrency and restore gates stay separate.
Detailed P&L classifications, owner aggregate boundary, report API/OpenAPI and
screens/browser journeys still precede K016 completion. K017 and R2+ have not begun.

### Observed local run — 11 October 2026

The reporting run completed and removed only its synthetic fixture. On Windows
x64, Intel i7-8550U (8 logical CPUs), 7.9 GiB RAM, Node 24.19.0 and PostgreSQL 18.4:

| Restricted-runtime read | Samples after five warmups | p95 ms | Maximum ms |
|---|---:|---:|---:|
| Dense-account first page, limit 100 | 50 | 1,393.637 | 1,454.104 |
| Dense-account middle page, limit 100 | 50 | 1,506.379 | 1,612.033 |
| Complete statement aggregates | 50 | 2,930.207 | 3,856.938 |

All three p95 values meet the local 3,000 ms target; the statement maximum does
not. Statement p95 has limited headroom, so this is not production/concurrency
acceptance. Every sampled result passed the independent balance/count assertions.
The same ledger SQL's EXPLAIN ANALYZE executed in 1,561.828 ms: scoped journal
bitmap scan (698 rows), journal-line primary-key index scans (698 loops), and a
101-row limit before retained-version enrichment. No index was forced. Existing
subledger warm/historical p95 values were 23.293/11.338 ms. Total fixture setup,
all benchmark phases and cleanup took 372.58 seconds.
