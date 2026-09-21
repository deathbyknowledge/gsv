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
| 3. Profiles and first contact | Explicitly published `/@username` profiles, authenticated bounded text approaches, durable accept/decline/block, peer-bound pairing and preserved first messages. | Gateway routing, Kernel identity/admission/pairing, web | Pending |
| 4. Everyday communication | Contacts/inbox, messages/resources/replies, private read position, mute/archive/report, truthful delivery/retry, and owner-initiated Ship help. | Kernel/Conversation, shared web services and Instrument | Pending |
| 5. Shared relationship context | Consented shared connections, attributed recommendations/advisories, selected local subscriptions, withdrawals and deliberate introductions. | Kernel policy and bounded projections, protocol, web | Pending |
| 6. Private message search | Owner-scoped full-text search across eligible hot and archived messages, durable indexing/backfill, correct authorization/deletion and visible coverage. | Search projection/DO, Conversation source jobs, lifecycle, web | Pending |
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
