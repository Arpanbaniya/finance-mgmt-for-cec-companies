# Versioned company chart of accounts

Status: account-master vertical slice; K012 remains partial.

Five catalog operations manage company-scoped account metadata. Codes normalize to uppercase and are permanently reserved per company. Creation binds type, normal side and control role. Patch accepts only name, nullable parent and report mapping. Generic statement sections must match the immutable account type; cash-flow classification remains explicitly unclassified until configured. These fields neither certify a reporting framework nor activate tax policy.

Current finance managers may write; accountants and auditors may read. Organization administration alone confers no finance permission. Transaction-local RLS uses the restricted runtime role, exact organization/entity scope and current membership/entity grants. Composite parent foreign keys prevent cross-company references. Writes acquire the organization lock before parent checks or idempotent replay, serializing hierarchy changes, archive and membership revocation. SQL guards also enforce current authority, scope, actors, classification immutability and version increments.

Parents must be active ordinary accounts of the same type. Recursive ancestry rejects self-links and indirect cycles. An active child prevents parent archival. Concurrent reciprocal reparenting and archive-versus-child creation cannot commit an invalid hierarchy. Archived accounts cannot be edited or deleted; archival records the current actor, reason and database timestamp. Archived codes cannot be reused.

Every insertion/update appends a database-owned immutable snapshot in account_versions within the same transaction. The runtime role may read scoped snapshots but cannot insert, update or delete them. Metadata audit and durable original creation/archive responses commit atomically with the account and snapshot. Replay requires current authorization and identical canonical input; a repeated archive returns its original result even after the account becomes inactive. If-Match protects edit/archive and the response exposes ETag; create additionally exposes Location.

The company screen has labelled create/edit forms, current-page parent selection, immutable-classification disclosure, explicit conflict reload, read-only state and reason/confirmation-based archival. Account identifiers and previous snapshots are not financial amounts. No seed chart, journal, balance, statutory rate, calendar, event-account purpose mapping or numbering series is invented.

Contract, dedicated local PostgreSQL/auth and real Chromium tests cover strict fields, response schemas, duplicate-code races, scope/revocation, stale edits, hierarchy races, direct SQL denial, original-result replay, immutable snapshots, snapshot-failure rollback and browser persistence. Fixture deletion is restricted to generated local test organization IDs. Hosted databases are not reset or migrated by this implementation.

Before K013 financial posting is introduced, add dependencies for account mappings, posted journals, open items and opening balances, and bind journal lines to retained master versions. Fiscal periods, control-purpose mapping and numbering must be implemented and accepted before K012 is complete. No later release starts here.
