# Internal journal foundation

## Boundary

This is the first K013 slice, not a financial posting release. There is no journal HTTP route or UI, no approval bypass, and no runtime permission to execute `write_manual_journal`. Only a migration/operator connection can exercise this internal primitive. Production operators must not use it to create business journals. Runtime grants explicitly deny posting until a persisted source/approval adapter exists. Local integration fixtures deliberately use privileged credentials to verify the primitive; they are not company approval evidence.

The primitive currently handles ordinary manual journals in NPR on demo entities. Source type and event are fixed internally to `journal`/`post`. Control-account posting, source reversals, live policies and unsupported dimensions fail closed. Branch is the only implemented dimension; payroll/trade/personnel masters and their versioned adapters are separate work.

## Transaction and invariants

`domain/posting` parses strict decimal-string input, supported calendar dates, UUID references and bounded protected versions. `features/accounting/posting-kernel` owns no transaction and calls the internal SQL function with a caller-owned client. The function validates again independently of TypeScript, locks organization then fiscal period then accounts in sorted ID order, allocates a source-bound number, creates an immutable header and its lines, and appends an audit record. A failure in any later operation in that transaction rolls all these effects back, including the series counter.

Header and line totals are `numeric(20,2)` and cross the application boundary as strings. Each line has exactly one positive side. Deferred constraint triggers on both tables independently require two to five hundred contiguous lines and exact equality between line totals and header totals. An empty header, a missing line or a one-paisa difference cannot commit. This is not a row-local balance check.

Journal lines retain composite company/account/version references. Inserts require an active, current, ordinary master version; later metadata edits do not rewrite the retained snapshot. Account archival is blocked by any posted line. Branch references are checked at insertion and protected by a composite foreign key against deletion or movement between companies. Posted headers and lines reject updates/deletes even for the owner connection. A line can be inserted only in its header's original PostgreSQL transaction, preventing later balanced append operations.

Durable uniqueness is independent of request keys/principals: `(organization, entity, source type, source ID, event kind)`. Concurrent identical source calls return one stored receipt. Changed content is rejected. Current scoped finance authority is checked before replay. Stored replay does not alter posted data, reallocate numbers or repeat audit effects. Distinct source calls serialize and receive distinct numbers.

## Verification and remaining work

`tests/unit/posting.test.ts` verifies strict input, decimal normalization, one-sided/exact totals, overflow and rejection of source/approval overrides. `tests/integration/posting.test.ts` exercises real PostgreSQL source races, sequential numbering, direct runtime denial, owner immutability, late-line denial, deferred balance failure, full transaction rollback, account/control/branch checks, retained versions, company isolation, revocation and closed/live-policy denial. Only the dedicated loopback test database is used; no hosted data is reset or seeded.

K013 remains in progress. Required before runtime activation: persisted maker/checker source snapshots and decisions, content/version dependency invalidation, approved source-state transition in the same transaction, typed financial outbox, canonical durable idempotency responses, broader supported source/dimension adapters and their acceptance evidence. K014 journal lifecycle/reversal and later releases have not started. Open-item/opening dependencies must be added with those modules. Existing API catalog/parity remains unchanged.
