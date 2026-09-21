# Social implementation workstream

The product and architecture contract is
[RFC 0002](rfcs/0002-social-model.html). This file tracks how we implement it.

## Delivery agreement — 2026-09-21

Use one feature branch, `feat/social`, in the isolated worktree
`/home/john/HAM/gsv-social`. Build the seven agreed batches as separate logical
commits on that branch. They are implementation checkpoints, not separate
releases or permission to merge incomplete features into main.

The integration target is one complete-feature PR. A draft may be used for CI
and review during development, but it stays unmerged until the agreed scope,
supported upgrades, and user acceptance are complete. The RFC's “first release”
and “follow-up” labels describe product dependencies; the seven batches below
are all included in this feature branch's agreed delivery scope. Items explicitly
deferred by the RFC remain deferred.

Main and existing production behavior stay unchanged during development. Keep
the existing permissions/search and WhatsApp branches separate; reconcile their
actual shared dependencies before the eventual integrated release. Do not merge
or deploy merely because an intermediate batch is ready.

## Batches

| Batch | Outcome | Primary ownership | Status |
| --- | --- | --- | --- |
| 1. Federation correctness | Enforce participant roles on local and inbound work-request actions; expose failed/unsettled exchanges accurately; preserve existing delivery and resource fences. | Kernel federation handlers/store, protocol and affected clients | Implemented; awaiting CI and human validation |
| 2. Shared contracts and storage | Versioned federation, trusted human/Process provenance, stable message/reply references, relationship policy, numbered migrations, and contact Conversations with no Process handler. | SDK/protocol, Kernel, Conversation storage | In progress |
| 3. Profiles and first contact | Explicitly published `/@username` profiles, authenticated bounded text approaches, durable accept/decline/block, peer-bound pairing and preserved first messages. | Gateway routing, Kernel identity/admission/pairing, web | Profile publication/editor in source; media and first contact pending |
| 4. Everyday communication | Contacts/inbox, messages/resources/replies, private read position, mute/archive/report, truthful delivery/retry, and owner-initiated Ship help. | Kernel/Conversation, shared web services and Instrument | Pending |
| 5. Shared relationship context | Consented shared connections, attributed recommendations/advisories, selected local subscriptions, withdrawals and deliberate introductions. | Kernel policy and bounded projections, protocol, web | Pending |
| 6. Private message search | Search one selected conversation, including indexed archived text, with current authorization and visible historical coverage. Whole-inbox search is deferred. | Existing Conversation SQLite/FTS5 and maintenance, Kernel authorization | Implemented; CI passed at 8ac2eb6b; human trial pending |
| 7. Scoped assistance | Generic Process scope/context propagation, exact approved drafts, optional bounded support helpers, resource/recipient enforcement through all syscall presentations and descendants. | Kernel authority, Process context/execution, protocol, web | Pending |

Batch 4 is a useful complete-flow review checkpoint for human communication.
It does not end this branch's scope or authorize an intermediate merge.

## Decisions to make concrete before public intake

- Exact approved-peer/approach-bound acceptance handshake, lost-response
  recovery and safe setup-secret retention.
- An enforceable production boundary for actual outbound destinations, including
  redirects/DNS behavior; a DNS lookup followed by unconstrained fetch is not
  sufficient.
- Supported v1/v2 interoperation window and meaningful legacy status. New wire
  records follow storage/read support; downgrade cannot discard committed data.
- Initial row/byte/rate budgets and full-budget behavior, with a concrete
  capacity assessment before enabling public admission.
- Explicit attention-policy migration for existing contacts. Preserve existing
  admitted responsibilities/promises and make the change visible to the owner.
  Implemented in v056; CI and acceptance remain required.

These belong to the relevant owning batch. Do not bypass them with UI-only
checks, a model verdict, or a new bespoke authorization mechanism.

## Boundaries and acceptance

- Installation routing and Kernel authorization stay authoritative. My spaces
  owner identity, login account and published social alias remain distinct.
- Preserve pinned actors, existing contacts, generations, pairing secrets,
  conversation IDs, messages, immutable resources and supported upgrade paths.
- Incoming approaches create neither unrestricted Process work nor automatic
  promises. Local relationship context does not become a network-wide graph.
- Managed web search is independent of private message search. Private content
  does not go to Exa or a model to implement lexical search.
- Prefer a clear product limitation for secondary features over extra
  infrastructure. Keep behavior in its existing owner until an observed need
  justifies a separate component. This does not weaken authorization or durable
  messaging guarantees.
- Coordinate shared frontend/session/protocol edits with the independent
  `feat/desktop-tauri` workstream; do not modify its worktree.
- Protected prompt/standing-context files remain read-only without a specific
  new user request. Jev integration and the RFC's other deferred features are
  outside this workstream.
- Add meaningful regression coverage at owning and cross-component boundaries.
  The user's standing preference is no local tests, lint, typechecks, builds or
  browser/live probes by the agent. Use CI for automated checks and provide
  concrete human trial instructions, including two independently routed spaces,
  upgrade/retry/recovery, authorization, and lifecycle cases.
- Keep commit descriptions and this status truthful. Neither a proposed test nor
  source inspection is a passing runtime result. Final readiness requires the
  complete agreed feature and explicit visibility of remaining limitations.

## Current checkpoint

The worktree was created from `origin/main` at
`e917c3f4d47ee835b45140ea9dc63ff7e3768984`. The existing RFC documentation commit
was brought onto the branch as `8ea7ade4`.

Batch 1 enforces requester/performer roles on local and signed inbound v1
updates. The requester can withdraw an unaccepted offer; only the performer
can accept, reject, start, complete or confirm cancellation. V1 cannot express a
stop request after acceptance, so it does not offer that action to the requester.
Pending local changes cannot be extended before their receipt. A crossed remote
operation may still conflict under v1; its failed exchange remains visible.

Migration v053 preserves delivery confirmation separately from request state,
including beyond outbox retention. Failed and pending terminal updates remain
in the open request list and do not resolve their responsibility as settled.
Old states without proof remain explicitly unconfirmed. Recovery of an already
applied inbound update binds the exact delivery, not a coincident timestamp.
Regression cases cover participant authority, receipt fencing, retention and
upgrades, with the two-space trial updated for confirmation-aware actions.

Source changes and protocol generation are complete for batch 1. No local tests,
lint, typechecks, builds or browser/live probes were run. CI and user acceptance
remain outstanding. No merge or deployment has occurred.

Draft integration PR: https://github.com/deathbyknowledge/gsv/pull/330.
Esteve explicitly simplified batch 6 to search inside the existing Conversation
DO only. No additional Search DO, account-wide index, indexing transport, or
cross-conversation query fan-out. New message/index rows can commit together;
older history uses bounded local backfill with visible coverage. The RFC and
storage diagram now reflect this decision. Other messaging batches continue.
Batch 1 is commit `940f0dd6`. Its first CI passed workspace, adapter and lint
checks; four existing inbound fixtures expected a requester to report performer
states. Commit `26600137` corrects those fixtures to use outgoing offers and a
remote performer, preserving the lifecycle and removal assertions.
CI at `26600137` passed all 2,286 gateway unit tests, workspace, adapter and lint
checks. Integration typechecking then caught two untyped signal assertions;
the v2 message batch corrects them. That is not yet a passing integration run.

Batch 2's handler separation is commit `41cd4de4` (v054): contact text threads
no longer create or dispatch input to a personal Process. Attachments continue
to use the existing durable archive owner without admitting an inference run.
The next source batch adds v2 message/receipt paths, protocol negotiation,
runtime-derived provenance, reply references and archive-preserved origin
mappings. Regression sources cover legacy migration, version replay fences,
signed inbound identity checks, and two-space replies. CI and human acceptance
are still required. Relationship policy and v2 work operations remain unfinished
parts of batch 2. See `docs/architecture/social-federation.md` for version and
egress decisions.

The attention cutover removes automatic Ship work from pairing, incoming
messages/offers and remote revocation. Local work offers and explicit acceptance
retain responsibility tracking; inbound updates advance only already admitted
work. V056 preserves old global social-source preferences in an owner-specific
notice and leaves the responsibility ledger unchanged. The obsolete global
source producers and controls are removed; later scoped assistance will own
its own admission. Fleet displays the notice with a human-only dismissal.
Migration and inbound regression cases plus the two-space trial cover the new
behavior. No local validation was run.

The next relationship slice uses v057 to add private saved/muted/notification
preferences and pinned-actor blocks to existing Kernel storage. Preference
updates require the current revision. Human-only blocking retires transport,
pending delivery/pairing and resources atomically; unblocking does not restore
old authority. Block pagination and row budgets are explicit. UI integration,
notification delivery and conversation view state belong to batch 4 and remain
unfinished. Source regression cases cover foreign/stale edits, preference
retention, blocked re-pairing, queued work and resource cleanup; CI is pending.

Relationship policy is committed as `b50b0050`. That checkpoint also corrects
stale shell fixtures, missing syscall activity labels, and v2 discovery's handling
of empty POST body streams identified while following CI failures. Latest-head
checks are still in progress; the branch is not ready for acceptance or merge.

Conversation search now uses migration v006, atomically indexes new messages,
retains index entries across archival, and backfills history through a durable
Conversation alarm cursor. It returns explicit building/limited/error coverage
and caps index rows/text, query terms, pages and excerpts. The Kernel checks the
same owner on both sides of the RPC. Contact threads expose search and reopening
the matching history; SDK, CodeMode and `message search` use the same syscall.
Regression sources cover archive retention, interrupted backfill, old-schema
upgrades, literal query syntax, permission checks and continued message admission
at index capacity. No local validation was run. This slice advances batch 6
while the broader profiles, inbox, shared context and assistance work continues.

The public egress boundary now uses a shared HTTP helper for discovery, pairing,
delivery and resource reads. Production Gateway composition and Wrangler configs
enforce strictly public global fetch. Application checks reject local/private
destinations, credentials, non-HTTPS and redirects; explicit development settings
allow loopback peers only for a loopback installation. Regression sources cover
address spellings, mapped IPv6, redirect cancellation and production configuration.
The required runtime connection-time guarantee is documented in the architecture
guide. This does not yet enable public approaches.

CI completed successfully at `8ac2eb6b`, including Gateway unit/integration tests,
workspace, adapters, lint and release checks. The preview build also passed.
Search's prior failures were a Shell test using an unauthorized Process caller
and a caught Durable Object rejection surfaced twice by the test pool; both
fixtures now exercise their intended boundary. No local validation was run.

The profile slice adds v058, direct-human draft/publication syscalls, signed
immutable projections with durable cleanup, revocation-fenced public alias and
subject routes, and the Settings editor/preview. Regression sources cover stale
edits, late publication after unpublish, storage failure/retry, alias ownership,
HTML escaping, conditional responses and two-space resolution. This new slice
still requires CI. Public images and first-contact handoff/intake remain part of
batch 3; inbox, v2 work operations, shared context and assistance remain in scope.

Profile CI at `f2bce8a0` passed all 2,333 gateway unit tests and workspace checks.
Lint requested clearer schema naming/optional-property construction; integration
typechecking found a missing SDK namespace declaration. `f2b0f483` and
`6e9e7fc1` fix those and include capability-gated publication notifications.
The complete new profile integration flow still awaits a passing CI run.

The first-contact contract now lives in `docs/architecture/social-approaches.md`.
It reuses invitation derivation and receipts with an exact peer/approach-bound
claim signature and durable confirmation before the issuer dispatches messages.
The storage slice defines strict envelope contracts and v059's bounded,
owner-scoped request records, private setup material, idempotent append recovery
and revisioned decisions. No public approach endpoint or syscall is enabled by
this storage slice. Claim/confirmation execution, cleanup, capacity measurements
and the user flow are still required before public admission.
