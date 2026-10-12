# Dated party statements

The catalog's dedicated `GET parties/{id}/statement` is a finance-only,
read-only operation. It uses `parties.read`; owner aggregate reporting does
not expose party identities. Every read and cursor page establishes transaction-local
organization/entity/user scope and current database RLS. Runtime source posting
privileges remain withheld. The generic `reports/party-statement` variant remains
disabled rather than introducing a second implementation.

## Query and history

`asOfDate` is required and inclusive. Optional `fromDate` defaults to 1900-01-01;
it cannot follow as-of. Opening means activity strictly before from-date. The
engineering extensions `knownAt`, `limit` (1–100, default 25), and opaque `cursor`
bound repeated reads without extending the catalog. Repeated/unknown query keys
are rejected. Knowledge is a UTC instant retaining six fractional digits.

Capture knowledge only after obtaining the organization policy/posting lock.
A single SQL statement reads complete balances and bounded activity. Sources
and their journals must both be recorded by knowledge and posted by as-of.
Applications and inverse allocations use their effective dates. Capturing fresh
knowledge includes subsequently recorded backdated activity; replay does not.

The statement name/status/version comes from the retained master at knowledge,
not current terms. Older master snapshots used transaction-start `recorded_at`;
visibility uses the greater of it and the trigger-stamped snapshot `updated_at`,
which is captured after the organization lock. No retained history is rewritten.
Current master name on the screen is labelled separately. Private contact, address,
tax identifiers, bank fields and actor details are absent from statement payloads.

Activity is ordered by posting date/source UUID, with source and journal references
and signed effects on each separate book. Cursor scope includes party, organization,
entity, dates and knowledge. The database also verifies the anchor is an actual
visible source. A cursor is not authorization; every page rechecks access.

## Reconciliation and exclusions

AR, AP, customer deposits and supplier advances never net. Each book shows
opening, increases, decreases, closing and independently reconstructed subledger
opening/closing. Retained account-version classifications determine normal-positive
journal effects. Open items less signed allocations reconstruct AR/AP; on-account
capacity less signed usage reconstructs deposits/advances. Direct settlements do
not create unapplied cash capacity. On-account allocation inverse events preserve
and restore history. The existing private producer rejects direct-payment
allocation reversal as deferred; statements do not enable that future workflow.

The domain reconciliation gate rejects inconsistent movement/subledger/ageing
totals without returning partial data. Money remains exact strings, including
amounts above JavaScript safe-integer precision. Supported aggregate overflow
fails closed; no rounding through Number occurs.

Ageing uses retained due dates: due on or after as-of is current, followed by
1–30, 31–60, 61–90 and over 90 days overdue. Zero outstanding contributes zero;
changing current payment terms does not change posted due dates.

Metadata includes entity/currency, dates, captured knowledge, generation instant,
party-specific journal watermark/source count, report version and mapping basis.
Complete aggregates do not depend on activity page size. Drafts/promises, unknown
future workflows and non-party-linked journals are excluded. No financial mutation
or statutory certification is performed. Unimplemented source screens are labelled,
not fabricated links. An unused party has a genuine empty history; unavailable
services/permissions are not displayed as zero.

Acceptance evidence is recorded in the requirements register. The broader source
modules and certified close remain separate delivery requirements; this feature
does not declare R1 complete. A dedicated local 100,000-line fixture with 500
open items and 200 allocation events was measured across current, page-two,
historical-knowledge and historical-business-date statements (50 reads each).
Independent expected balances passed; p95 values were 165.283, 158.760,
130.476 and 129.127 ms respectively. This measures local warm service/database
reads, not hosted capacity, concurrent load or browser/network latency.
