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
| 3. Profiles and first contact | Explicitly published `/@username` profiles, authenticated bounded text approaches, durable accept/decline/block, peer-bound pairing and preserved first messages. | Gateway routing, Kernel identity/admission/pairing, web | Profiles, private image uploads/cropping, bound first contact and People request UI in source; latest CI and human acceptance pending |
| 4. Everyday communication | Contacts/inbox, messages/resources/replies, private read position, mute/archive/report, truthful delivery/retry, and owner-initiated Ship help. | Kernel/Conversation, shared web services and Instrument | Private inbox/read/archive and policy controls in source; delivery/replies/report/assistance still in progress |
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

CI at `ab7efab2` passed Gateway unit/integration, workspace, adapters and lint,
including the new profile publication flow. The next source batch implements
first-contact admission, exact signed claims, durable confirmation, bounded
recovery, and unaccepted-history cleanup. It adds CI cases for lost responses,
proof of recipient key possession, private-invitation separation, blocking,
retention and the real two-space flow. Web request composition and inbox design
continue after this backend checkpoint; it is not feature completion.

The first-contact contract now lives in `docs/architecture/social-approaches.md`.
It reuses invitation derivation and receipts with an exact peer/approach-bound
claim signature and durable confirmation before the issuer dispatches messages.
The storage slice defines strict envelope contracts and v059's bounded,
owner-scoped request records, private setup material, idempotent append recovery
and revisioned decisions. No public approach endpoint or syscall is enabled by
this storage slice. Claim/confirmation execution, cleanup, capacity measurements
and the user flow are still required before public admission.

People is now a dedicated `/people` view with profile-to-compose handoff,
separate received/sent requests, mobile list/detail navigation, and preserved
drafts. Its first source commit `6ebad100` passed workspace and lint CI; Gateway
checks are still running. V061 adds private inbox/read/archive state to Kernel
storage and bounded previews from committed messages. The reading pane marks
visible messages only. Contact controls separate saving, mute, notification
policy, block and revoke. Digest delivery, optimistic contact sends, reply UI,
reporting, address-book pagination and the remaining batches are not yet done.
No local validation or browser trial was run.

The next message slice moves a human send into the visible thread immediately,
keeps a new composer draft independent of that acknowledgement, and retains the
exact send/reply identity after an uncertain response. Contact delivery reads
are batched for the displayed messages. V062 adds explicit recoverable-message
retry with the original payload, original seven-day window and a retry epoch
against stale outcomes. Permanent failures and retired generations stay closed.
A failed ordinary human message is UI attention, not an automatic Ship promise.
The owning-store and optimistic-send CI cases are added but not yet validated.
CI also found missing inbox syscall documentation signatures, justification
comments and a tab-attention fixture race; this slice addresses those findings.
The first-contact test harness fix still needs a Gateway run beyond the protocol
contract check. All unimplemented agreed batches remain in scope.

Profile images are implemented in source as private bounded PNG uploads, browser
crop/export, explicit draft inclusion and revision-bound publication. Image R2
reads recheck current publication; withdrawn images stop serving before physical
cleanup. V063 owns reference-aware cleanup and upload reservations. CI first
caught the SDK treating binary syscalls as JSON convenience methods; the streaming
interface correction is in `25e27795`. The eviction hang also exposed uncollected
body-read deadline timers, addressed at their owning network boundary in
`610fb1dc`; the next CI must confirm recovery.

The address-book slice adds owner-indexed keyset pages and local name/origin
filtering to `contact.list`, exact identity/ID lookup, a paged People address book
and an explicit blocked-identities screen. V064 retains human-readable private
block labels after request cleanup. Shell history now resolves the exact contact
rather than searching a potentially incomplete list. This slice still needs CI.

CI at `6a160123` passed the new avatar and address-book boundary cases and the
previously hanging eviction recovery test (2,355 gateway cases passed). One
filesystem-copy fixture lost its internal contact list during the paging change;
it is restored in the next slice. Lint's named-return-contract findings are also
addressed. This is not yet a passing complete integration run.

Selected-evidence reports now have a two-step People review, explicit recipient,
exact message copies and optional checked files. They use ordinary contact
messages and the existing durable outbox, keep retry content stable and bind the
reviewed recipient generation. Contact screens now live under People; Fleet's
duplicate list and composer are removed. The People navigation guard also covers
unsent report drafts. CI and human trials remain required for this slice.

The work-request slice adds v2 participant-owned statements, immutable offers,
causal validation, bounded full-prefix recovery and an explicit sync action.
Migration v065 keeps those records in the owning request table, with the r12y
projection in the same transaction. Crossed stops and acceptance remain visible;
a completion report, dispute and acknowledgement are distinct. People now offers
work composition and reviewed actions with optional notes, exact retry identity
and navigation protection. Protocol, store/handler, two-space and UI decision
regressions are added for CI. No local validation or UI trial was run. Shared
relationship context, durable attention and scoped assistance remain in scope.

The durable attention slice adds v066, one bounded alert per contact Conversation,
a replay checkpoint, owner-scoped pages/counts and exact-sequence dismissal.
Notify is immediate; Digest retains its first-message 24-hour deadline and uses
the existing Kernel scheduler for a bounded announcement. Reading, archive and
notification-policy changes suppress queued attention without public read
receipts. People exposes Catch up and the shared header shows ready alerts.
Storage reconstruction, stale dismissal, mute/archive, upgrade and capability
regression sources are included for CI. This remains source implementation, not
a rendered UI acceptance claim. Shared context and scoped assistance continue.

The selected-context backend adds v067 in Kernel SQLite: explicit signed
statements, mutual consent for connection disclosures, bounded source
subscriptions, staged snapshot/delta sync, opaque viewer-bound cursors and
finite display leases. The existing federation outbox carries consent decisions
and withdrawals; no context event starts a Process or changes capabilities.
Generation changes and unsubscribe remove cached visibility, and old responses
cannot restore it. Store and cryptographic boundary regressions are added for
CI. People publication/subscription/review UX, introductions and scoped Ship
assistance remain unfinished. No local checks or browser trial were run.

The People context slice exposes local attributed context beside person and
request details, per-source/kind subscriptions, selected quoted evidence,
publication review/revision/withdrawal and exact connection-consent review.
Owner publication and consent lists are paged. Control deliveries use the
existing receipt and retry primitives with a final supersession fence before
outbound dispatch. CI runs the new behavior checks; rendered acceptance is
still the maintainer's task. Introductions and scoped Ship assistance remain.

Connection consent now carries an independently signed short display proof.
The approving endpoint renews only its unchanged active human decision; it stops
renewing on withdrawal, contact replacement or inactive ownership. Cached views
take the minimum of the source lease, statement expiry and the other endpoint's
proof. A publisher therefore cannot keep an old approval alive by issuing new
page leases. The still-unreleased v067 schema includes the bounded renewal
deadline alongside each consent. Expiry/renewal/withdrawal regressions are added
for CI, with no local execution.

Introductions now have guided ordinary-message flows for requesting a mutual
introduction, asking the proposed recipient first, and reviewing the agreed
introduction in each separate conversation. Only a selected human/approved
reply offers the completion action; the intermediary explicitly confirms what
both people agreed to share. Each send has an exact generation-bound intent and
normal delivery status. There is no new introduction authority or pairing path.
Explicit contact-based public-profile resolution pins the subject/key and
rechecks the contact generation after fetch. CI regressions cover that boundary
and exclude private aliases, replies and attachments from introduction drafts.
