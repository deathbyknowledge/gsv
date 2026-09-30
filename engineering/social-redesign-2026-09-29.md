# Agreed social redesign

Accepted by the maintainer on 29 September 2026 after reviewing PR #330.
The preview inference detour is complete; resume this work next.
This decision supersedes the broader delivery scope in the old social branch.

On 29 September, set the `gsv-previews` GitHub environment's existing
`GSV_PREVIEW_INFERENCE_MODEL` override to `@cf/deepseek-ai/deepseek-v4-flash-0731`,
the primary model read from production routing. Applied and verified the same
model on the six live previews (#258, #320, #330, #352, #362 and #363), preserving
their other settings. Future preview deployments inherit the override; this is
an explicit selection, not automatic synchronization with future routing changes.

## Delivery approach

- Preserve `feat/social` / PR #330 as reference material. Do not merge it as-is.
- Rebuild the agreed product on current main, keeping the implementation compact.
- Reuse useful identity, delivery, retry and revocation code and its regression tests.
- Rewrite the product composition where that is clearer than pruning abandoned abstractions.
- Make two reviewable changes: federation correctness first, then People, profiles and first contact.
- After the agreed PR cleanup batch, WhatsApp #320 remains the next priority; do not insert another feature ahead of it.

## Keep

- Federation participant authority, truthful delivery status, idempotent retries and revocation.
- Contact conversations independent of mandatory Process handlers.
- People: conversations, private contacts, unread/archive state, mute and block.
- Explicitly published public profiles and first-message requests; private invitations remain supported.
- Human/Ship authorship and durable reply references.
- Search through the implementation already shipped on main.

## Defer or remove from this delivery

- Richer cross-space work lifecycle beyond the existing request correctness fixes.
- Separate Catch up surface and daily digest expansion.
- Shared connections, recommendations, advisories and relationship subscriptions.
- Introduction workflows and their consent-renewal machinery.
- Restricted helper Processes, selected-material scope grants and the special draft-approval system.
- The branch's duplicate full-text storage and background indexing of existing archives.
- Compatibility machinery for abandoned, unshipped experiments unless a supported upgrade path actually requires it.

Remove optional features together with their machinery. Do not retain a feature while stripping protections required by its promises. Preserve migrations that have shipped on main, especially Conversation search migration 5.

## Interaction model: who handles the conversation?

| Situation | Agreed behavior |
| --- | --- |
| Someone new contacts the user | A message request; no agent work until accepted or explicitly handed to Ship. Acceptance alone does not imply delegation. |
| The user handles the conversation | Messages arrive in People. The user can ask Ship to help when needed. |
| The user chooses “Let Ship handle this” | Ship can read and reply with its ordinary capabilities and approval rules, involving the user when needed. |
| The user asks Ship to contact someone for a task | Ship tracks the work, sends the message, and receives replies as continuations of that work. |

The receiving space independently decides whether its Ship handles the incoming conversation. An instruction to one Ship never grants authority to the other.

Delegating a particular task must not silently enable permanent handling of every future conversation with that contact. Keep temporary task ownership distinct from any standing contact preference.

Do not promise “Ship never replies on its own” after handing it a conversation. That is not what the runtime enforces or what the handoff means. Existing capabilities and approval rules still govern each action, and replies remain attributed to Ship.

## Incoming messages and continuation

Authorship tells the user who sent a message; human versus Process authorship must not by itself determine whether Ship can receive a relevant reply.

Distinguish:

1. A new incoming message needing a local decision about who handles it.
2. A reply continuing work the user already authorized.
3. Delivery acknowledgements and duplicate deliveries, which must not create agent work.

Associate replies with the existing responsibility instead of creating a new responsibility for every message. This gives the exchange continuity and a completion point. Do not claim this alone guarantees models never continue an unnecessary exchange; reuse ordinary runtime controls.

## Ownership and architecture

- Conversation stores committed messages and reply references.
- Kernel owns contact permissions and admission to human or Ship attention.
- `r12y` tracks delegated work and connects relevant replies to it.
- Ship and Crew use their ordinary Processes, capabilities and run control.
- Add only the small local association needed between an outgoing exchange and the responsibility awaiting its reply. Remote messages must not choose a local Process or grant authority.

Do not introduce a second helper runtime, Process role system or per-contact sandbox. If selected-material-only assistants become a product requirement later, design and review that resource restriction separately; an ordinary account alone does not enforce such a promise.

## Validation when implementation resumes

## People surface

People owns conversations with other people, their message requests and the private address book. At a glance it answers who wrote, what is unread, and whether the user or Ship is handling a conversation. Primary actions are read/reply, accept/decline a request, and hand a conversation to Ship or take it back.

Use a conversation list and a spacious message pane. Requests opens the first-message decision queue; Contacts opens the private address book. Keep search within the selected conversation and reuse main's search endpoint. Put infrequent relationship actions in its details rather than beside every message. A new-conversation dialog supports saved people, a public profile address and private invitations. Public profile editing remains in Settings. Fleet keeps processes, targets and responsibilities and links to People where needed.

Ship handoff uses ordinary capabilities and an ordinary responsibility. Per-task reply continuation is separate from the standing contact preference. No assistant persona, scoped helper runtime, shared social graph or digest is part of this screen.

Integrate against current main and obtain CI for the actual head. Test the owning boundaries and a two-space flow: first contact and acceptance preserving the first message; human and Ship authorship; delegated reply continuation; no work from delivery acknowledgements or duplicate deliveries; interrupted/retried delivery; media; mute/block/reconnect; and main's search.

The review of the old branch is recorded locally at `/tmp/gsv-pr-sweep-2026-09-29/social-assessment.md`. That assessment is evidence and history; this file records the approved direction.

## Visual refinement, 30 September

Keep reading and replying as the main People job: one conversation header, a
readable message column and a quiet composer. Show message actions on interaction
while keeping failures and active Ship handling visible. Details opens a focused
dialog; saved contacts and archive are secondary actions, and connection management
and structured work open on demand. Saving is address-book membership, independent
of conversation access or delegation. Memory and People share a full-height shell
divider, with content kept below the header.

Conversations are the default People view. A counted Requests entry opens the
incoming decision queue; sent and past requests are secondary there. Contacts is
an address-book selector reached from the heading or New conversation, rather
than an equal conversation tab. Both views offer a direct return to conversations,
retaining the previous conversation and draft. New conversation filters saved
people locally and can open a public profile address. The conversation header owns
Hand to Ship / Ship handling · take back; Details keeps infrequent preferences.
The composer uses the same attach text action as Zen.
