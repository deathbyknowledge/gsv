# RFC 0001: Sovereign Ship Federation

Status: **implemented for staging validation**

## Summary

This RFC defines direct communication between independently owned GSV
installations. It carries the design through Ship identity, contacts, durable
messages, structured requests, responsibilities, and immutable resources. It
does not define social applications, public feeds, groups, a global directory,
or a shared data service.

Every installation remains sovereign. Each GSV stores its own conversations,
responsibilities, request state, grants, and retained resources. Federation
exchanges authenticated facts and acknowledgements; it does not synchronize a
shared database.

The smallest useful model is:

```text
Ship A                         Ship B
  local user                    local user
  local contacts                local contacts
  local conversation            local conversation
  local responsibilities        local responsibilities
       |                             |
       +--- authenticated request -->|
       |<-- durable receipt ----------+
```

An acknowledgement means the receiving GSV durably committed the operation.
It does not mean its intelligence read, accepted, or completed the resulting
work.

## Goals

- Give each installation a stable, verifiable Ship identity.
- Let humans explicitly pair two Ships and revoke the relationship locally.
- Deliver text and immutable resource references exactly once from each
  installation's point of view.
- Turn received work into ordinary Kernel-owned responsibilities.
- Support bounded, typed requests with explicit lifecycle transitions.
- Resolve resource bytes lazily over the existing streaming body model.
- Preserve the existing protocol-peer, Conversation, responsibility, and
  resource-reference abstractions.
- Make every retry safe across Worker termination, Durable Object eviction,
  network ambiguity, and duplicate delivery.

## Non-goals

- A global account, contact, discovery, or identity provider.
- Public profiles, posts, feeds, repositories, or social applications.
- Multi-party groups.
- Replicating conversations or Process histories between installations.
- Giving a remote Ship arbitrary syscall, Process, filesystem, or target
  authority.
- Treating a hostname, display name, TLS connection, or transport session as a
  local user identity.
- Replacing adapter, browser, machine, or local protocol-peer transport.

## Terms

- **Ship**: one GSV installation as a federated principal.
- **Ship identity**: a signing key and self-certifying identifier owned by that
  installation.
- **Contact**: one local authorization record for a remote Ship.
- **Contact generation**: an incarnation of a contact relationship. Revoking
  and pairing again creates a new generation so old traffic and grants cannot
  become valid again.
- **Subject**: the local human for whom a contact was paired. A remote caller
  never supplies or selects this uid.
- **Delivery**: one immutable operation with a sender-assigned id.
- **Receipt**: the receiver's signed statement that it durably committed or
  rejected a delivery.
- **Resource grant**: local authorization for one contact generation to resolve
  one immutable local resource revision.

## Release baseline and schema

Federation v1 first ships as Kernel schema migration v033. The only supported
predecessor is the v032 schema on `main`; intermediate federation schemas from
development branches are not deployment formats and are not migrated. A
development deployment that ran an earlier draft must reset its unshipped
federation state.

Migration v033 creates the complete v1 schema in one step. Every record owned
by a contact generation stores that generation explicitly. This includes
outbox and inbox deliveries, structured requests, resource grants, and active
resource-read leases. Pairing, delivery, request, and resource state are
represented by explicit states and constraints rather than by the presence of
columns added by later migrations.

## Ownership and trust boundaries

The installation Kernel owns federation authority because it already owns
local identity, users, Conversations, responsibilities, and durable task
coordination. Federation does not introduce another authority database or a
second intelligence.

The outer managed Gateway resolves an accepted origin to an active immutable
`installationId` before addressing a Kernel. A random wildcard hostname must
not allocate a Kernel or federation state.

Federation itself is deployment-model neutral. A standalone singleton and a
managed installation expose the same Ship document and wire endpoints. Their
local Kernel names and routing mechanisms never cross the wire. Standalone to
standalone, standalone to managed, and managed to managed pairings therefore
share one protocol; each receiving Ship only needs a reachable HTTPS origin.

Three identities remain deliberately separate:

1. The transport authenticates a remote Ship and contact generation.
2. The local contact record authorizes that Ship to communicate with one local
   subject.
3. Each committed Message records remote author provenance.

None implies another. In particular, a valid remote envelope does not become a
human protocol peer and does not receive local `calls`, `signals`, or
`implements` grants.

Remote data is untrusted content even after its sender is authenticated.
Authentication answers who sent it, not whether its instructions are safe.

## Ship identity

On first use, the Kernel generates an ECDSA P-256 signing key with WebCrypto.
The private key remains in Kernel storage. The public key is canonicalized and
hashed to produce the self-certifying Ship id:

```text
shipId = "ship:" + base64url(SHA-256(canonicalPublicKey))
```

The public discovery endpoint returns a signed document:

```ts
type ShipDocument = {
  version: 1;
  shipId: string;
  origin: string;
  publicKey: { kty: "EC"; crv: "P-256"; x: string; y: string };
  protocols: ["gsv-federation/1"];
  issuedAtMs: number;
  signature: string;
};
```

Consumers must verify all of the following:

- the key hashes to `shipId`;
- the signature covers the canonical unsigned fields;
- `origin` is canonical HTTPS, except explicit localhost development;
- the fetched origin equals the document origin; and
- the protocol version is supported.

The canonical origin is routing metadata signed by the Ship. The immutable
installation identity remains the local storage and authorization boundary.

Key rotation is outside v1. A changed key is a different Ship unless a later
protocol adds an explicit, mutually authorized rotation record.

## Pairing

Pairing is an explicit human operation. It is not inferred from an incoming
message, display name, username, hostname, or possession of an authenticated
browser session on another installation.

### Invite creation

The inviting Kernel creates 32 random bytes and stores only their hash in an
invite whose state is `issued`, together with:

- the local subject uid;
- expiry;
- the inviter's Ship id and origin.

The human receives an encoded invite containing the origin, Ship id, expiry,
and raw token. Invite material is a short-lived bearer credential and must not
be logged, persisted in a Conversation, or placed in query parameters.

### Invite acceptance

The accepting human submits the invite to their own authenticated GSV. After
verifying the inviter's document, their Kernel first commits a local pairing
attempt in state `pending`. The attempt binds the token hash, owner, remote
Ship and subject, origin, and public-key identity. It is the local authority
for whether a later response may replace the current contact.

The accepting Kernel then:

1. fetches and verifies the inviter's Ship document;
2. creates or reads its own Ship identity;
3. sends the invite token, its signed Ship document, and a bounded subject card
   to the inviter;
4. derives the same contact secret as the inviter; and
5. commits the local contact only after the inviter returns a signed committed
   result and the exact local pairing attempt is still `pending`.

The inviter atomically changes `issued` to `accepted`, creates its contact,
and stores the complete accepted contact, generation, and thread snapshot on
the invite. Replaying that invite within the receipt-retention window returns
the same signed result to the same accepting Ship; it cannot pair another
Ship. Cancelling changes `issued` to `cancelled`; neither terminal state may
change to the other.

On the accepting side, a successful exact response changes `pending` to
`committed` and records the contact, generation, and thread. A newer explicit
attempt for the same remote identity changes an older pending attempt to
`terminal` before sending anything. A delayed response for that older attempt
therefore cannot replace the newer relationship. A replay for a committed
attempt succeeds only while its recorded contact generation remains current.
An already-persisted pending attempt may retry past the invite's public expiry
for the bounded receipt-retention window, allowing it to recover an acceptance
whose response was lost. A new attempt cannot start from an expired invite,
and a stable rejection from the inviter makes the pending attempt terminal.

Remote wall-clock values never order or authorize pairing. Receipt times are
local retention metadata; the signed acceptance response carries identities,
generation, and thread, not a peer-selected security epoch.

Both sides derive, rather than transmit, the contact secret:

```text
secret = HKDF-SHA-256(
  input = inviteToken,
  salt = sorted(inviterShipId, accepterShipId),
  info = "gsv-federation-v1/contact"
)
```

The invite is the initial proof of authorization. Normal traffic uses the
derived secret plus the pinned Ship identities.

### Revocation

Revocation is immediate and local:

- mark the contact generation revoked;
- reject new inbound envelopes for that generation;
- stop retrying unsent outbound work;
- invalidate its resource grants; and
- create a best-effort signed revocation delivery for the remote Ship.

The remote notification is advisory. Local safety never depends on receiving
it. Pairing the same subjects again derives a fresh secret and generation. An
implementation may reactivate the stable local contact and Conversation ids,
but old-generation deliveries remain terminal while their grants and read
leases are deleted.

Replacing or revoking a contact generation atomically terminalizes its pending
deliveries, requests, and responsibilities and deletes its grants and read
leases. An old generation is a normal security state within federation v1,
not an upgrade-compatibility mode.

## Carrier and authenticated envelope

Federation v1 uses HTTPS as the inter-installation carrier. This is not a
second logical protocol: its payload has the same request, response, body,
cancellation, and idempotency semantics as GSV protocol peers. HTTPS provides
simple reachability between independently deployed Ships without requiring a
permanent WebSocket in either Kernel.

Public discovery uses `/.well-known/gsv/federation/v1/ship`. Authenticated
operations use the versioned `/_gsv/federation/v1/` namespace. The underscore
reserves a small transport path outside installation UI and user content; it
does not imply a hidden account, privileged caller, or separate source of
authority.

Each normal request contains or signs:

```ts
type FederationEnvelope = {
  version: 1;
  deliveryId: string;
  senderShipId: string;
  senderSubjectId: string;
  recipientSubjectId: string;
  generation: string;
  timestampMs: number;
  nonce: string;
  payload: FederationPayload;
  signature: string;
};
```

JSON delivery signatures are HMAC-SHA-256 over every unsigned envelope field,
including the canonical payload. Resource-read signatures cover the HTTP
method, canonical path, both Ship subjects, contact generation, timestamp, and
nonce without a JSON body.

The envelope timestamp authenticates the freshness of that HTTP attempt. It is
not a Message or request timestamp and never becomes local Conversation state.

The receiving Kernel:

1. bounds the request before parsing it;
2. finds the exact active contact generation;
3. verifies timestamp, signature, and canonical origin assumptions;
4. applies replay/idempotency rules; and
5. commits state before replying.

Unknown contacts fail without revealing local users or allocating contact
state. A delivery id is globally unique for its contact generation. The
receiver stores a bounded receipt record, so duplicates return the original
outcome without appending another Message or responsibility.

## Durable delivery

Sending is a local durable workflow, not an inline best-effort fetch.

### Sender

The sender atomically creates an outbox item before resource copying or network
I/O. A message with resources begins as `preparing`, holding the original
intent and contact generation. The owning Process retains the complete resource
set as one idempotent batch keyed by the existing delivery id. Only then does a
Kernel transaction create the exact grants and immutable payload and advance
the item to `pending`. A durable task resumes either phase with bounded backoff.

The outbox state machine is
`preparing -> pending | preparation_failed` and
`pending -> delivered | terminal`. No failed or terminal record becomes
pending again.

For a user-visible message, the sender also commits its own canonical Message
once. A retry never creates another local Message.

### Receiver

The receiver commits one transaction containing enough state to recover:

- the inbox receipt;
- request state, when applicable;
- the intent to append the canonical Message; and
- the intent to create or update the responsibility.

Conversation and Kernel state live in different Durable Objects, so the
receiver cannot make their writes one SQLite transaction. It therefore uses a
recoverable local admission state machine. It returns `OK` only after the
Conversation append and responsibility mutation are durably complete. Any
retry resumes that exact admission.

The inbox state machine is `received -> committed | rejected`. Admission
persists the authenticated contact generation before projection. A durable
Kernel task owns recovery of every `received` row after an error or Kernel
eviction; request-lifetime background work is not the durability mechanism.

### Meaning of outcomes

- `OK`: the receiver durably committed the operation and its local projections.
- `REJECTED`: a stable policy or validation decision; retrying unchanged input
  will not help.
- transport failure or `RETRY`: outcome is unknown or transient; the sender
  retains the outbox item and retries with the same delivery id.

`OK` never means a human or model has handled the work. Completion of a
structured request is a separate signed transition.

## Conversations and Messages

Each side owns its own canonical contact Conversation. The two Conversations
share correlation identifiers but are not replicas and need not have equal
sequence numbers or identical retention.

An inbound message appends a Message whose author records:

- remote Ship id;
- local contact id and generation;
- bounded remote subject label; and
- originating delivery id.

The remote sender cannot choose the local Conversation id, handler PID, uid,
or sequence. The Kernel resolves all of them from the contact.

Delivery payloads carry no wall-clock timestamps. The sender timestamps its
own local Message when it accepts the send intent, and the receiver timestamps
its local Message with the durable inbox receipt time. Local sequence numbers,
not either Ship's clock, order each Conversation.

V1 uses one direct Conversation per local subject/contact relationship. A
later generation may continue that local Conversation while cryptographic
traffic and resource grants remain strictly fenced by generation. Future
multi-party Conversations require a separate membership protocol; they must
not overload direct contacts.

## Responsibilities

Each successful pairing creates one local `contact.added` responsibility on both
Ships, keyed by the local contact id and contact generation. It gives the local
intelligence durable work to learn who the contact is and preserve useful verified
context in the owner's existing knowledge system. Exact acceptance replays return the
same record, while pairing again after revocation creates a new generation-scoped
responsibility.

An inbound message creates one delivery-scoped Kernel responsibility for the
local subject. A structured request has at most one stable responsibility for
its complete lifecycle, keyed by the local contact and request ids. Federation
is a deterministic producer, not a special Process event path.

The responsibility references the contact, delivery, Conversation Message,
and request where relevant. It contains bounded untrusted summaries rather
than arbitrary remote prompt text. The exact message remains in the
Conversation.

The existing responsibility rules apply unchanged:

- an idle Ship may be awakened;
- a busy Ship observes the revisioned ledger transition on its next turn;
- the system prompt remains fixed within a context epoch;
- retry/recovery cannot create duplicate obligations; and
- the Ship may reply, delegate, wait, reject, or resolve through ordinary
  operations.

Request and responsibility state change in the same Kernel SQLite transaction.
The mapping is:

| Request state | Responsibility state |
| --- | --- |
| incoming `offered` | `open` |
| outgoing `offered` | `waiting`, blocked on the contact |
| `accepted` or `active` | `active` |
| `rejected` or `completed` | `resolved` |
| `cancelled` | `cancelled` |

Local and remote request transitions update that same responsibility. A remote
delivery id may be recorded as its latest evidence, but never creates a second
request-update responsibility.

## Structured requests

A structured request is an authenticated proposal, not a remote syscall. It
cannot directly execute a tool, create a Process, access a file, modify a
schedule, or message another endpoint.

V1 provides a generic bounded record:

```ts
type ContactRequest = {
  requestId: string;
  type: string;          // namespaced, bounded identifier
  title: string;         // bounded untrusted summary
  details?: JsonValue;   // bounded structured data
  state: "offered" | "accepted" | "rejected" |
         "active" | "completed" | "cancelled";
  createdAt: number;
  updatedAt: number;
};
```

Those timestamps belong to each Ship's local request record. The wire offer
and transitions carry bounded content, identity, revision, and state; the
receiving Ship assigns its own creation and update times when it commits them.

Only valid state transitions are accepted. Every transition is idempotent and
creates or updates the corresponding responsibility. Local policy or the Ship
decides what accepting a type means. A namespaced `type` is descriptive and
does not dynamically install code or grant a capability.

This is enough for delegated work, invitations to collaborate, requests for a
resource, and completion reports without designing a social application
system.

## Immutable cross-GSV resources

Resource metadata travels in the structured delivery. Bytes do not.

When sending a resource, the source Kernel:

1. verifies the caller may read the source reference;
2. durably records the message intent;
3. asks the owning Process to retain all referenced revisions as one atomic,
   retryable batch;
4. records grants scoped to the exact contact generation and revisions; and
5. places opaque resource ids plus content type, size, immutable revision, and
   optional display metadata in the payload.

The 48 MiB transfer-retention bound is independent of the Process model-context
hydration budget. A retained resource may remain reference-only to the model
while still being valid for lazy transfer.

The recipient rewrites that descriptor into a local reference:

```ts
{
  type: "file",
  target: "contact:<localContactId>",
  path: "/resources/<opaqueResourceId>",
  revision: "<opaque immutable revision>",
  contentType: "...",
  size: 123
}
```

The locator is not a bearer capability. On `fs.transfer.send`, the recipient
Kernel authorizes the local caller, signs a resource request as the exact
contact generation, and streams the remote response through the existing
binary body channel with backpressure and cancellation. The source Kernel
rechecks the active contact and exact grant immediately before opening the
local resource.

The source reopens the exact retained revision before serving it. The receiver
verifies signed size, revision, and content-type metadata before accepting the
stream, and the binary body boundary enforces the declared byte count. A
different revision is a failed resolution, never a replacement under the old
reference.

Immutability and availability are different. Revocation may make a remote
reference unreadable. A recipient that needs independent durable ownership
must explicitly import and retain the bytes as a new local immutable resource.
That import records provenance but does not mutate the original Message.

## Limits and abuse resistance

The staging v1 policy applies these deterministic bounds:

| Scope | Bound |
| --- | ---: |
| Invite lifetime | 1 hour by default; 7 days maximum |
| Outstanding invites / owner | 20 |
| Invite creation / owner / hour | 20 |
| Contacts / owner or installation | 1,000 |
| Public JSON body | 128 KiB |
| Message text or request details | 32 KiB |
| Resources / message | 16 |
| One resource or all resources / message | 48 MiB |
| Pending deliveries | 50 / contact, 250 / owner, 500 / installation |
| Pending inbound admissions | 25 / contact, 250 / installation |
| New deliveries / minute | 60 / contact, 300 / owner, 600 / installation |
| Active resource grants | 20,000 / contact, 100,000 / installation |
| Resource reads / minute | 240 / contact, 1,000 / installation |
| Concurrent resource reads | 8 / contact, with a 15-minute recovery lease |
| Active requests | 100 / contact |
| Retained requests | 5,000 / contact for up to 90 days after termination |
| Receipt/idempotency retention | 8 days after settlement |
| Accepted clock skew | 5 minutes |
| Delivery retry | 12 attempts or 7 days, whichever comes first |

Preparing and pending records are never pruned by the settled-record retention policy.
Settled outbox and inbox records remain for eight days so delayed replays still
return the original outcome. The Kernel prunes bounded batches during ordinary
federation operations and recovers all admitted preparing or pending outbox work after
eviction, up to the installation backlog cap.

Bodies are authenticated before expensive parsing or storage where possible.
Streaming endpoints never buffer an entire resource. Every accepted body has
one owner and one terminal outcome: consumed, forwarded, or cancelled.

Rate limits and quotas are local policy. A remote Ship cannot claim entitlement
values or use federation to spend managed inference or email budget directly.

## Failure and recovery invariants

- No network call occurs inside a synchronous SQLite transaction.
- Every state transition preceding network I/O is durable.
- Pairing responses are authorized by a current local attempt, never by a
  peer-provided timestamp.
- One logical caller intent owns one stable idempotency key, and an ambiguous
  retry reuses it.
- Duplicate input returns the original outcome.
- Ambiguous output remains pending and is retried with the same identity.
- Revocation fences queued, in-flight, replayed, and resource traffic by
  generation.
- A delayed completion from an old generation cannot mutate a new contact.
- Kernel eviction cannot lose an accepted delivery or resurrect a revoked one.
- Conversation append, responsibility admission, and delivery receipt recover
  independently but converge before `OK` is exposed.
- Retry exhaustion becomes inspectable local delivery debt; it is not silently
  dropped.

## Observability and privacy

Telemetry may record Ship/contact pseudonymous ids, operation type, byte
counts, timings, attempt counts, and outcomes. It must not record invite
tokens, contact secrets, message text, request details, filenames, resource
bytes, prompts, or Process activity.

The Contacts surface distinguishes:

- paired contact versus transport reachability;
- sent locally versus acknowledged remotely;
- request offered versus accepted/completed; and
- referenced remotely versus retained locally.

## Staging slice and acceptance criteria

The initial staging release is complete when two clean managed installations
can:

1. expose and verify independent Ship identities;
2. pair through one human-created invite and list/revoke the contact;
3. exchange a text Message with duplicate-safe local Conversations;
4. wake the receiving Ship through one deduplicated responsibility;
5. offer, accept/reject, and complete a structured request;
6. attach an immutable resource reference and stream its bytes lazily;
7. recover delivery across receiver failure, sender failure, and response loss;
8. reject forged, expired, replayed, revoked-generation, cross-contact, and
   oversized traffic; and
9. show contact Conversations, transferred resources, and request state in the human UI.

The end-to-end test must use two installation ids and two origins. A one-Kernel
mock does not establish the security boundary.

Before release, the interoperability matrix must also exercise a standalone
singleton paired with a managed installation. Managed directory or Accounts
bindings must not be required by the federation handler itself.

## Deferred work

- public discovery and contact cards;
- social application manifests;
- public artifacts, posts, feeds, and reviews;
- groups and multi-party membership;
- contact key rotation and device-level Ship keys;
- store-and-forward relays for offline origins;
- capability negotiation beyond the v1 protocol/version document;
- independent resource mirroring and garbage-collection policy; and
- transport optimization such as long-lived peer WebSockets.

These can build on the v1 identity, contact generation, durable delivery,
request, and resource contracts without changing their security meaning.
