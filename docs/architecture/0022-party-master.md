# Scoped customer and supplier masters

R1 party master slice: five catalog operations (list, create, read, PATCH and archive) and the customers/suppliers workspace screen. Party statements remain unimplemented; K017 is not accepted as a whole.

## Identity and access

One entity-scoped identity has customer, supplier or both roles. Finance managers write; accountants and auditors read. Owner, organization administrator and workforce roles do not automatically receive private party details. Current membership and entity grants are rechecked transactionally, including idempotent retries. PostgreSQL uses the existing restricted runtime role and transaction-local scope.

New masters reserve the same UUID in the existing internal subledger identity registry. Existing source IDs are not replaced or adopted, and legacy private fixture reservations are not fabricated public masters. The raw financial producer stays private, without a runtime EXECUTE grant. New master-backed AR/AP originations require an active matching role. Applications/inverse allocations may still resolve retained history after archival; they are not new originations.

## Terms and duplicate policy

Names are trimmed and whitespace-collapsed; entity-local case-insensitive names and trimmed case-insensitive nonempty tax identifiers are unique, including archived records. This is an engineering duplicate guard, not a universal legal identity rule. Separate companies may use the same name/identifier. No fuzzy matching or automatic merging.

Payment terms are integer days from 0 through 3650 (bounded master metadata, not a statutory requirement). Credit limits are optional nonnegative NPR decimal strings, stored at two decimals without floating-point conversion; supplier-only records cannot hold a credit limit. Null means unconfigured; zero is explicit zero. These defaults do not retroactively change document due dates, approve credit, or enforce future invoice policy. Contact/address are optional text, not private banking records.

Masters are created active. Active status is not PATCH-editable; the finite archive command requires a reason, current If-Match and stable Idempotency-Key. No undocumented delete/reactivation API is introduced.

## History and concurrency

Organization-level serialization coordinates party edits, membership changes and source posting. Every persisted master version has an append-only snapshot and transactional audit metadata. PATCH omission preserves prior values; null explicitly clears nullable fields. Role removal is refused when that side has consumed history. Metadata changes never rewrite sources, due dates, journals or allocations.

Archive refuses any unresolved open item or unapplied on-account deposit/advance across all committed events, including future-dated commitments. Fully settled used parties may archive while retaining their identity, source links, versions and eventual statements' history. New contract/workforce modules must add their actual active dependency guards before those modules become available. No hard deletion or financial history mutation.

## Acceptance boundary

Required evidence: strict DTO and decimal checks; real restricted-role RLS, duplicate/concurrency/idempotency/version/revocation/rollback tests; actual posted source archival checks; browser form/API/database/reload/confirmation/mobile/read-only flows; catalog/OpenAPI parity; full shared lint/type/build/test gates. Live authenticated acceptance additionally requires hosted database provisioning; a public deployment alone is not that evidence.

Local evidence, 12 October: 17 party contract checks, nine party database cases,
and three actual financial lifecycle/concurrency cases pass. The shared suite
passes 208 unit/contracts, 206 PostgreSQL/auth, five private-storage and eleven
Chromium cases (430 total). The browser confirms exact large credit limits,
nullable clearing, reload persistence, competing edit→412→reload, read-only
denial, membership revocation, archive cancellation/confirmation, ETag/replay,
four immutable master versions and one archive audit. The 360px screenshot was
reviewed without overflow. Lint/typecheck, final build (42-second compile),
45/256 route parity and migration replay pass. All 40 earlier OpenAPI operations
remain unchanged except the intended party audit filter. Thirteen protected
database triggers were restored and the restricted runtime role rechecked.
Exact commit deployment/CI evidence is recorded locally.

Forward0029 fixes explicit NULL credit semantics for supplier-only masters and
uses finite source kinds instead of wildcard prefixes. Forward0030 retains
decimal credit limits as strings in master snapshots. Applied migrations were
not rewritten. Corrections on archived financial history may reopen then
resolve an item without reactivating the master or allowing new originations.
