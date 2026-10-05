# Approved-source posting boundary

## Scope

This extends the K013 journal foundation with an internal approved-source protocol. No journal HTTP routes or screens are introduced. Source preparation is still a trusted operator/test boundary: `prepare_journal_posting_source` is not executable by the application role. K014 must provide the controlled draft, submission, rejection, cancellation and reversal adapters before exposing manual journals to users. A production operator must not use the test producer to bypass that lifecycle. Live profiles and control-account posting remain unsupported here.

The restricted runtime can execute only finite approval and posting commands referencing a persisted source UUID/version. It cannot supply a posting body, an approval flag, an actor identity or a source type to these commands. The raw `write_manual_journal` function and all direct financial/source/decision/result/event writes remain denied. Existing RLS and application authorization apply to reads and commands.

Standalone runtime number allocation is also revoked. The ledger's definer-owned posting transaction still allocates numbers atomically. K012's allocator invariants remain independently tested through an explicitly privileged local primitive fixture; current-runtime tests assert allocation denial and prove valid approved posting still allocates exactly one number. No numbering API is introduced.

## Frozen approval evidence

`journal_posting_sources` is append-only. Each version retains its canonical body/hash, maker, exact total, applicable active policy definition/version and threshold, entity version, effective account-mapping revision and branch snapshots. Account IDs and exact protected versions are in the body. A policy is selected from the stored posting date and exact debit total; no client-provided threshold or computed total is trusted. The trusted producer validates through `domain/posting`, with monetary facts rechecked in SQL and the full journal independently validated by the ledger primitive at posting.

Decisions are immutable and unique per command/reviewer. The current actor must be a scoped finance manager, must not be the source maker, and must review the current protected version with unchanged dependencies. Repeating the same decision returns its original ID; changing its reason conflicts. Posting counts distinct, non-maker reviewers who still have current finance/company access against the frozen threshold. An accountant's submission grant does not imply approval or posting authority.

Creating a newer unposted source version does not overwrite an earlier snapshot or decision, but makes those earlier approvals unusable for new money. Changes to protected account versions, branch snapshots, entity policy/version or effective mappings invalidate unposted approvals. The original policy/threshold stays frozen. Metadata changes do not rewrite an already posted journal or its retained master versions.

## Transaction, replay and locks

`post_authorized_journal` locks the organization before rechecking current finance authority. New posting locks its period, entity and referenced branch rows; account/number locks remain in the underlying journal primitive. Account, membership and mapping writes share the organization mutex. Branch locks additionally cover direct branch edits that do not use that mutex. A posting queued behind period closure sees the closed state and fails.

The same transaction creates the balanced immutable ledger, number and counter advance, source-consumption receipt, audit, typed `journal.posted` event and original response. The consumption receipt is the durable source-state transition; no mutable `posted=true` escape hatch is used. A unique organization/company/source key prevents financial duplication across principals and request keys. A failure even at outbox insertion rolls all these effects back.

Posting results use a separate append-only table with no runtime read/write grants. This avoids trusting the more general result store that the runtime can insert into. The namespace includes organization, company, principal, operation and key; the request is bound to the immutable source ID/version. Same key/different source or version conflicts. A committed replay returns the original request ID and receipt after current authorization, before stale/dependency/closed-period rejection. A new key for the same consumed source also returns its original receipt, without reallocating a number or duplicating an event. Revoked posting authority cannot retrieve that receipt via the command.

The transaction-level TypeScript adapter takes a caller-owned client so a later controlled source module can add effects before commit. It never opens a separate financial transaction or emits external side effects.

## Evidence and limits

`tests/integration/authorized-posting.test.ts` uses privileged credentials only to prepare isolated fictional source fixtures and manage local fault injection. Actual decisions and posting run with the restricted production-shaped runtime role through application services. Coverage includes canonical snapshots, exact threshold boundaries, self-approval, revoked reviewers/posters, concurrent decisions/posts, lost responses, changed requests, new protected versions, mapping/account/entity/branch invalidation, branch-edit and close/post races, immutable evidence, direct SQL denial, company isolation, downstream failure and outbox-failure rollback. Existing `posting.test.ts` independently covers deferred balance failure, raw runtime denial, owner immutability, late-line denial and source numbering. Typed receipt tests reject numeric/unsafe money and imbalanced results.

The typed journal event is durably queued, not delivered. Financial event consumers, lease/recovery UI, external notifications and scheduling remain separate K011 work. Manual-journal routes/UI and dated reversal remain K014; trade/payroll/control/subledger adapters arrive with their modules. K010/K011 and R1 are not complete merely because this internal kernel works. No hosted database reset, seed or migration is performed.
