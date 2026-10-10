# 0011 — Scoped manual-journal lifecycle

## Scope

Extend the persisted manual draft with submit, independent approve/reject and atomic post. This is a partial K014/R1 increment, not release completion. Dated reversal, financial-source adapters, approval queues and financial-event delivery remain pending. Ordinary NPR manual journals remain restricted to fictional demo profiles and non-control accounts.

## Authority and frozen content

The original creator alone submits. The service reads saved content under the organization lock and supplies its canonical form to a finite SECURITY DEFINER transition. Only that adapter invokes the owner-only source producer; the runtime cannot prepare arbitrary sources or write raw ledger entries. Submission sequence is independent of editable head version. Each submission freezes content/hash, scoped dependencies and the applicable effective-dated policy/threshold.

Maker-checker is deliberately conservative: both the creator and every historical content editor are excluded from review. Content authorship is determined from immutable creator/audit evidence. Independent, currently authorized reviewers can approve once per submission or reject with a reason, including after their approval. No delegation or one-person exception is introduced. Current eligibility is rechecked when counting quorum and before new posting effects.

## State and retained evidence

Draft becomes submitted; enough valid distinct decisions make it approved. An edit or rejection returns it to a new draft version and clears its current submission. Cancellation clears an unposted current submission. Earlier immutable sources, decisions, revisions, receipts and audit events remain retained. Fresh submission requires fresh decisions. Account/policy/mapping/branch changes invalidate the frozen dependency snapshot; they do not rewrite it.

The read projection joins the head, review snapshot and posted number in one scoped SQL statement. API money remains exact decimal strings reconstructed from saved lines. UI affordances come from the service; React only handles confirmation, notes, retry and conflict reload.

## Atomic consumption and bypass prevention

Manual sources can reach lower approval/posting helpers only through an owner-created permit bound to actor/action/source and the current PostgreSQL transaction. The permit table has no runtime SELECT/DML grants and no RLS policy. Raw runtime helpers therefore cannot bypass editor exclusion or advance the ledger without its source head. The adapter deletes the permit in the same transaction. Nonmanual trusted local kernel fixtures retain their existing protocol.

Posting serializes against scope/source changes, revalidates quorum and dependencies, requires an open period, and commits source consumption, ledger lines, document number, typed event, head version, immutable revision, audit and protected command receipt together. A failure of the head revision rolls all financial effects back. Before any replay, current scope and financial authority are checked. Original command bindings replay before stale-version rejection; changing version/reason with the same key conflicts. A consumed source with a different key/current financial principal returns the original result and creates no duplicate money.

The posted manual head rejects updates even by its owner. Ledger and source evidence remain append-only. No reverse endpoint exists in this increment; posted sources cannot be cancelled or patched.

## Migration and verification

0015 adds the finite lifecycle and permit guards; 0016 enforces posted-head immutability. 0017 is a forward repair for a PL/pgSQL local-variable namespace error found by lifecycle integration tests. Applied migration checksums are not rewritten. SQL scope comes from transaction-local settings and the restricted runtime role, not client identities.

`tests/integration/journal-lifecycle.test.ts` exercises frozen thresholds, authorship, raw-helper/permit denial, retained invalidation, rejection/cancellation, competing post commands, durable replay, revoked quorum, dependency invalidation, closed periods, scoped denial and injected atomic rollback. The browser journal story uses real authenticated creator/two-reviewer accounts, stale approval/reload, posting confirmation and persisted single-ledger evidence. Fixtures and cleanup are confined to the dedicated local database; no hosted database is reset.
