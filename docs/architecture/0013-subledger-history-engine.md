# Exact source-linked subledger history

## Boundary

The R1 subledger foundation is a pure domain engine, not a posted payment service or a public financial API. `domain/subledger.ts` validates retained journal-line evidence and derives balances from immutable allocation/reversal events. The engine does not load a database, authenticate a caller, acquire locks, post money, or prove that supplied evidence exists in PostgreSQL. Its inputs belong to trusted server adapters, never to a client request.

No new routes, permissions, runtime database grants, migrations or ordinary manual-control posting exceptions are introduced. The existing catalog remains unchanged. Party masters, opening batches, invoices, bills and settlements remain unavailable until their own controlled workflows ship.

## Financial rules

- Open items originate from exact AR/AP control lines belonging to an invoice, bill or opening batch. Their amount equals the retained line, with the correct debit/credit direction. One line cannot introduce the same balance twice.
- Capacity originates from a settlement's exact control line and source identity. Direct receipts/payments fully allocate their AR/AP control amount in that original posting. They cannot create an unapplied deposit by reversing an allocation or spending the same source again.
- On-account receipts/payments retain customer-deposit/supplier-advance capacity separately from open items. Application requires a separate exact AR/AP reclassification line, not reuse of the receipt/payment line. No implicit netting or cross-party allocation is allowed.
- Source, target and journal evidence agree on organization, entity, NPR, party, AR/AP side and target control account. Amounts are exact decimal strings. A history cannot overrun capacity or a target at a business-date or recorded-time prefix, even if a later reversal would hide the error in the final total.
- Reversal is a new event referencing one original application. It requires dated inverse control-line evidence, the retained account/version, and cannot precede the original business or recorded date. Duplicate reversal and reversal chains fail. Original records remain unchanged.
- Duplicate IDs/evidence fail; durable idempotency belongs to the eventual source command adapter, not this pure append planner.

## Cut-offs

`subledgerAt` requires an inclusive business `asOfDate` and an inclusive system `knownAt`. The latter is a normalized UTC instant with six fractional digits so PostgreSQL microsecond watermarks are not rounded down to JavaScript milliseconds. Events must be visible at both cut-offs. Origins not yet visible are omitted. Outstanding and unapplied values are derived, never mutable paid flags. Direct settlement reversals reopen target balances without inventing deposits.

Dates and retained accounting evidence are validated before computing a report. Malformed or inconsistent histories fail closed; missing records do not become zero. Business ordering is date, recorded instant and stable ID; an application precedes its inverse at an identical instant. Caller arrays and snapshots are not mutated.

## Required persistence work before acceptance

K015 remains in progress. Pure tests do not prove journal/subledger linkage in the database, transaction atomicity, RLS or allocation races. The next increment must add scoped composite foreign keys and append-only storage, controlled same-transaction source production, journal/subledger deferred consistency guards, and a restricted-runtime historical reader. No generic runtime source/evidence builder may be exposed.

Production adapters must load evidence from immutable scoped ledger rows, verify counterparty provenance, lock source/target IDs in stable order, recheck current authority/open periods, and persist source, balanced journal, allocation, audit, durable command result and event atomically. A deposit application must also prove its deposit/advance contra line; an allocation reversal must reverse that reclassification, not merely supply an inverse AR/AP line. This engine alone does not prove those complementary GL effects.

Backdated writes must preserve every business-date/recorded-watermark intersection, not just today's net balance. Database tests must exercise those intersections, simultaneous consumers and rollback failures. Queries need bounded scoped filtering and measured indexes; this in-memory domain engine is not a full-ledger production query or performance acceptance result.

Actual dependent allocations must integrate the existing private reversal-hold seam through an append-only controlled release lifecycle. A source cannot be reversed while an allocation remains active. Do not delete a hold or mutate financial history to release it. These integrations must precede source workflow activation.

## Verification

The independent synthetic tests cover AR deposits and AP advances, direct settlement splitting, exact paise/large amounts, partial and dated inverse history, dual cut-offs/microsecond boundaries, duplicate/orphan/cross-scope evidence, future origins, source/target caps and reuse before a recorded release. They are domain tests, not database or hosted financial-workflow acceptance.
