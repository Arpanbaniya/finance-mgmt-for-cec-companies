# Scoped subledger persistence

## Scope and authority

The R1 foundation now stores exact source-linked open items, settlement capacity and append-only allocation/inverse events. Migrations 0019–0021 extend the immutable ledger through an owner-only finite producer. The restricted web role receives scoped SELECT only, with no table DML, producer EXECUTE or access to private dependency releases. No new API catalog operation, permission, invoice/payment UI or approved business-document workflow is activated.

`subledger_counterparties` reserves scoped identity references; it is not the party master, terms, contacts or a customer/supplier role workflow. Its eventual integration with the controlled party master remains required. Opening batches, tax/withholding, refunds, bounces, source-document reversals and statutory/live-policy posting are not implemented here. The entity must remain in its labelled demo policy. Synthetic fixtures do not constitute company approval decisions.

## Atomic producer

`writeSubledgerSource` validates a strict finite internal body and delegates to `app_security.write_subledger_source` within the caller's transaction. It must never be invoked with an HTTP body or a web runtime privilege grant. The producer rechecks current finance membership and entity scope before replay, serializes at the organization, locks retained masters, resolves account versions itself and requires an open target period for new writes.

Each write commits together: source record, fiscal number, two-line balanced NPR journal, originating open item/capacity or allocation/inverse, dependency holds/releases, scoped audit and one typed event fact. Composite references bind organization/entity/party/source/account-version/header/line; current-transaction guards prevent later children or journal lines. Deferred checks reject incomplete financial effects, mismatched control links and missing dependency evidence. Source UUID plus canonical strict body provides internal retry identity; conflicting content fails. This is **not** the catalog's principal/operation/idempotency-key command contract. Approved source adapters must supply that durable command boundary before runtime activation.

The finite two-line examples are AR/revenue, expense/AP, cash/customer-deposit, supplier-advance/cash, cash/AR and AP/cash. On-account application posts a new deposit→AR or AP→advance reclassification with both exact contra lines. Direct allocation consumes the original control line completely; it cannot later become reusable deposit capacity. Its reversal is withheld until the controlled cash workflow exists.

Allocation inversion posts a new exact inverse journal with the original account/version pair and a reason in an open later period. It copies the original source/target/amount, allows one inverse only, disallows chains and preserves all original financial rows. Current account availability still applies.

## History and reads

Every target and capacity must remain between zero and its original amount at **every** inclusive business-date/knowledge-watermark intersection. Two complete independent prefix checks are insufficient; a regression demonstrates two applications visible without either inverse at an intermediate rectangle. The pure domain validator now checks each knowledge prefix in business order. PostgreSQL checks the complete rectangle set before commit, so an invalid backdated reuse cannot commit even if its final total looks correct.

`readOpenBalances` uses the existing transaction-local `journals.read` scope and RLS. One query selects at most limit+1 scoped origins and aggregates only allocations for that page. UUID keyset cursors, page limits 1–100 and decimal text outputs avoid unbounded ledger downloads, N+1 reads or numeric money boundaries. Both origins and events must satisfy the cutoffs. UTC strings retain six fractional digits; inclusive SQL comparisons are tested at the exact recorded instant and one microsecond before it. Outstanding is derived, never a mutable paid flag.

Target/capacity/date/recorded indexes and a scoped item-page index exist. The correctness-first deferred rectangle checker can grow expensive with long histories; measured production-sized performance and any semantics-preserving optimization remain outstanding. No latency or throughput acceptance is claimed from the small integration fixtures.

## Dependency lifecycle

An active allocation appends a hold for its target, capacity and application journals (distinct journals only). An on-account inverse appends corresponding release records backed by the actual inverse allocation and complete contra journal; it cannot delete or mutate the original holds. Omitting either a hold or release aborts the entire transaction. Release rows remain private and immutable.

This records the real lifecycle, but does not activate generic source reversal. The existing ordinary-manual reversal guard remains conservative: any hold blocks it. Valid subledger allocations do not originate on ordinary manual journals. Before activating invoice/payment source corrections, the shared dependency-clear guard must consume unreleased holds, preserve unrelated active dependencies and be rechecked in the final source-reversal transaction. The presence of release rows alone is not permission to reverse a source.

## Evidence and remaining acceptance

Real dedicated-local PostgreSQL tests exercise AR/AP journals, partial applications, exact cutoff boundaries, source replay/races, target/capacity competition, retained inverse versions, strict party/side/control scope, RLS/revocation, runtime INSERT/UPDATE/DELETE/EXECUTE denial, late-child/line denial, one-time inverse/release immutability, audit-fault rollback, and producer omission of mandatory open items/events/holds/releases. No parent guard is disabled to make a producer fixture pass. Fixture cleanup is local-only, scoped and restores append-only triggers after deferred checks.

K015 remains in progress pending dependency-clear consumer integration and measured history-growth/query verification. Approved document command binding, party-master integration and actual business source workflows must remain disabled until their prerequisites ship. R1 is incomplete; K016 and later releases have not started. Hosted authenticated acceptance requires private database provisioning and controlled forward migrations; local/CI evidence must not be presented as hosted financial operation.
