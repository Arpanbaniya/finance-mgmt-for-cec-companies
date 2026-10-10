# 0012 — Freshly approved dated manual reversals

## Contract and scope

The existing catalog `POST journals/{id}/reverse` accepts strict DateAction (postingDate, reason) with If-Match and idempotency. It prepares a linked inverse draft and returns its resource ID/version/status; it does not bypass approval or immediately write money. The same named submit/approve/reject/post routes complete that fresh source. This resolves the catalog's single reverse command without inventing an approval endpoint or borrowing the original approval hash for new content/date. Only ordinary NPR demo manual journals are supported; other source aggregates and reversals of reversals fail closed.

## Preserved history

0018 adds immutable reversal requests and completed links. The original posted head, ledger lines, number, source snapshot, approvals and audit remain byte-for-byte unchanged. Reversed is derived on read from a completed link; the stored financial status remains posted. A pending child changes neither money nor original version. Cancellation retains its request while allowing a replacement. Description edits can refresh current account versions, invalidate approval, and preserve the exact original accounts, exchanged money sides and dimensions. Dates and inverse lines cannot be repurposed through PATCH; database triggers independently enforce that rule.

Dates may not precede the original (an explicit engineering chronology rule). Draft creation and final posting both require an open target period. The original period may be closed. Original and inverse retain their separate dates so historical cut-offs before reversal still contain the original only; their combined account movements net to zero.

## Authority, dependencies and atomicity

Current finance authority and legal scope precede every create/replay. A new source freezes its applicable effective-dated policy and uses fresh independent reviewers; its creator/editors cannot review. Revoked reviewers and changed master dependencies are handled by the existing kernel. Request and final consumption serialize on the organization lock. One uncancelled request is permitted at a time; one unique completed link exists per original journal. Stable command bindings preserve retries, including after cancellation, without silently changing dates/reasons.

An owner-only, finite `journal_reversal_holds` seam represents consumed allocation/payment/reconciliation/opening/close dependencies. Runtime cannot read/write/release it. Creation and final inverse consumption check it under the same scope lock; adding a dependency after completed reversal is denied. Later controlled source modules must integrate their actual dependency lifecycle before release; this increment does not claim those modules exist. No public arbitrary-hold endpoint or generic source writer is exposed. Holds remain append-only until a separately designed controlled release workflow exists.

The internal raw writer remains runtime-denied. It selects reverse event/number kind only from the persisted request, validates exact inverse content again, and creates the completed link in its ledger transaction. Number, ledger, immutable link, source head/revision, private receipt, audit and typed journal event all commit or roll back together. An injected link-insertion failure proves no partial money/link/number/event/permit remains. The typed event is queued, not delivered by this increment.

## Acceptance evidence

`tests/integration/journal-reversal.test.ts` uses the actual restricted runtime and dedicated local PostgreSQL for fresh approval, competing requests/post commands, changed-key binding, cancellation replacement, inverse tampering, dependency holds, closed original/open later period, closed target denial, atomic fault rollback, cross-scope/current-authority denial, immutable links and retained account versions. The browser journal story performs actual reversal confirmation, new submission/two reviewers/post/replay, follows both source links and checks the unchanged original plus independent exact zero net/cut-off results in PostgreSQL. Public hosted smoke is separate from authenticated local/CI acceptance.
