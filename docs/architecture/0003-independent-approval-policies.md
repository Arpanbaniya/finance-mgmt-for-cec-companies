# Independent approval policies

Approval definitions are immutable entity-scoped resources. Creation produces a draft; a separate activation command produces version 2. There is no edit, retire or delete API. Definitions use NPR decimal strings, actual business dates with exclusive ends, a finite protected-action vocabulary, complete adjacent thresholds from zero through an unbounded final range, and one to ten distinct independent approvers. A permission must match every selected action.

## Authority and concurrency

The finite `policy_reviewer` role grants `approval_policies.activate`, but activation additionally requires an organization administrator or finance manager role. A maker cannot activate their own draft. Ordinary transaction approval does not grant policy activation. Another organization administrator assigns the reviewer role through membership administration; self-membership edits remain forbidden. Single-person organizations need a separate authorized reviewer; there is no silent bypass.

Activation holds a migration-owned, scope-checked organization row lock. Membership changes use that same row lock, so creation/activation recheck current authority after waiting. The policy row is then locked and its ETag checked. PostgreSQL RLS and triggers independently enforce maker/checker separation, immutable identity/definition, valid thresholds, canonical-payload/hash integrity, and nonoverlapping active policies for a shared action/date interval. Adjacent intervals are allowed. A policy with no end date prevents another policy for the same action from overlapping it; replacement/retirement needs a separately specified workflow, not a hidden mutation.

Idempotency uses organization, principal, entity-qualified operation and key. Activation request hashes include resource ID, original version and reason. A committed authorized replay returns the original command result before the stale-version check; changed requests conflict. Creation/activation, audit append and durable response commit in one transaction. Direct database writes are not an operator workflow; use the services to preserve audit/idempotency effects.

## Content-bound decisions

Domain submission primitives clone canonical JSON and bind organization/entity/source identity, creator, protected version, exact amount/currency, business date, source content, policy definition/version and selected threshold into SHA-256. Independent authorized distinct decisions reference this snapshot. Changing the protected content/version invalidates it. Later policy objects cannot weaken a previously copied submission. Actual financial submission/decision persistence and consumption remain part of the first protected financial document service; these pure primitives do not expose an approval API or post money.

## Audit and contracts

The entity audit endpoint returns append-only metadata with strict bounded cursor/action/target/actor/instant filters. Private change values and organization-wide membership events are not returned. Historical entity setup rows without an entity column are read only when their target is this entity and their action is an allowlisted entity setup action; historical rows are never backfilled or rewritten. Entity-scoped SQL receives the same restriction.

Five catalog operations are exposed: list/create/read approval policies, activate policy, and list entity audit events. Concrete schemas and ETag/Location/status contracts are generated into OpenAPI. Approval queues and journal submission/approval/posting endpoints remain unavailable until backed by real document state.

Migration 0003 is additive; applied migration hashes must not change. Schema generation output must be reviewed against the hand-authored security migrations before adding future generated migrations. Production migrations require separate administrator credentials, never the runtime deployment account.
