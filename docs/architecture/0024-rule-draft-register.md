# Typed rule draft register

K018 starts with immutable, entity-scoped draft definitions. This slice exposes only the catalog's list, create and get rule-version operations. Review, activation, retirement, posting admission and statutory source verification remain separate acceptance gates. K019 is not enabled by a draft.

The initial vocabulary is sales tax on invoices and purchase tax on bills: a positive percentage no greater than 100, or explicitly zero-rated, exempt or out-of-scope treatment. Percentage bases are exclusive or inclusive; rounding is half-up per NPR line. Rates and money are decimal strings. Inclusive calculations round net and derive tax as gross minus net. Input-credit eligibility must be explicit for purchase percentage tax. Scripts, arbitrary selectors, thresholds, payroll brackets and inferred legal rates are rejected, not approximated.

Applicability contains only event and exact uppercase tax code. Dates are AD, half-open, with an optional exclusive end. Fiscal-year selection is not part of this draft vocabulary: eventual posting must independently validate the document's open period and the applicable verified rule interval. Draft overlap is permitted for competing proposals; active overlap must be prevented by the future activation gate.

Each source reference records title, credential-free HTTPS URL, section and captured SHA-256. These are unverified metadata, not downloaded evidence or certification. Synthetic references must be visibly labelled. No external URL is fetched. Future verification must bind actual retained source documents, applicability, reviewer identity, timestamps and successful evaluator tests; entering a hash cannot satisfy that gate.

Finance managers create; finance managers, accountants, auditors and policy reviewers read. Owners and organization administrators gain no implicit rule access. Both service and SQL enforce current membership and transaction-local organization/entity scope. Creation obtains the organization policy lock before checking authority or replay. Synthetic drafts are accepted only for the existing demo profile; non-demo drafts remain unverified and cannot enable a live company.

The database owns creation time and a SHA-256 of its immutable JSONB definition, independent of the command hash used for replay. Actor comes from the authenticated scope. Restricted runtime has SELECT and INSERT only, never UPDATE, DELETE or TRUNCATE. Owner-level update/delete is also blocked by the append-only trigger. Audit, draft and receipt share one transaction. Lifecycle controls must retain the definition and demo flag; no generic edit or in-place relabelling route exists.

The catalog uses PolicyDraft for both request and response. OpenAPI uses PolicyDraftInput for the strict command and PolicyDraft for the server-owned response envelope, preventing schema overwrite. Existing operations are unchanged.

The screen offers structured selectors, bounded pagination, immutable details and a server-calculated hypothetical NPR 100.00 example. That example proves arithmetic only, not source validity or posting permission. There are no inactive verification or activation buttons.

Acceptance evidence is maintained in the requirement register after the relevant checks pass. K018 remains incomplete until independent source review, version/test-bound activation, active overlap/applicability/mapping gates, immutable retirement and demo-only posting admission are implemented and verified.
