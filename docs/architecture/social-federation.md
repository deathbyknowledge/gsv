# Social federation

The product contract is [RFC 0002](../../engineering/rfcs/0002-social-model.html).
This document records implemented wire and storage choices as the feature lands.

## Version selection

V1 remains byte-compatible at its existing routes. Its signed discovery document
continues to advertise exactly `gsv-federation/1`; unknown fields are not added to
that strict contract. V1 messages retain unspecified remote authorship. Its work
updates enforce participant roles and retain a separate exchange outcome.

V2 discovery uses `/.well-known/gsv/federation/v2/ship` and the same pinned Ship
key. GET and bodyless POST return the same signed document. Negotiation uses POST:
older Gateways return 404 for unknown POST routes, whereas GET may return the
Instrument SPA. This gives a definite missing-endpoint response without treating
HTML, malformed JSON, or a bad signature as permission to downgrade.

The document binds a version/domain, canonical origin, key-derived Ship ID,
features and a ten-minute validity window. Negotiation checks the already pinned
origin, identity and key. Only 404, 410 and 501 permit an initial v1 selection.
Once v2 is selected, a missing advertisement is an error, not a downgrade.
An installation caches a verified selection per contact generation for one day.
Each durable delivery separately captures its own wire version so retry or a
later contact refresh cannot reinterpret it.

The v1 compatibility window covers the first release series carrying v2 and the
following minor release series. Removal requires an explicitly announced
breaking federation release and at least 90 days of upgrade notice. Rollback may
disable new admissions; readers and retained v2 records cannot be downgraded.

## Messages and receipts

Contact Conversations have no Process handler. Pairing, message receipt, new
work offers and remote revocation do not admit Ship work. A local work offer or
explicit acceptance creates a responsibility; remote state updates continue to
advance existing commitments. V056 retains the previous global attention
settings for an upgrade notice while retiring those implicit producers. It does
not remove existing responsibilities. Scoped assistance is a separate admission
path and remains under implementation.

Relationship preferences stay in Kernel federation storage. Saving and muting
are private, revision-checked preferences independent of transport state.
Actor blocks use `(ownerUid, shipId, subjectId)` and survive contact generations.
A direct human block atomically retires the current transport, resource grants,
pending inbox/outbox work and pairing attempts; no dedicated block notification
is sent. Unblocking permits a future explicit pairing and never restores an old
generation or queued send. Blocks have separate bounded keyset pagination and
limits of 10,000 per owner and 20,000 per installation. A new block fails visibly
at capacity; an existing block remains enforced and can always be removed.

V2 message and receipt signatures include distinct `gsv-federation/2/delivery`
and `gsv-federation/2/receipt` domains. Payloads require their origin actor,
origin message ID, thread and submission provenance. The sender derives human
or Process submission from authenticated runtime context. Exact draft approval
will use the separate approved provenance once its authority path is implemented;
it cannot be supplied through `contact.send` arguments.

The recipient validates the message actor against its pinned contact and the
thread against the active generation. A reply may name either participant in
that thread. Incoming references may remain unresolved when messages arrive out
of order; they grant no access to another thread. Outgoing replies require a
locally stored origin mapping in the selected conversation.

Conversation storage retains the metadata and a unique origin-to-local-sequence
mapping. The mapping survives hot-message archival; immutable R2 segments retain
the same message metadata. Old messages are not assigned invented origin IDs or
provenance. V1 immutable resource transfer remains the resource carrier, with its
existing exact revision, contact generation, byte and cancellation fences.

The current implementation advertises only completed wire features. Profiles,
approaches, work operations and shared context will be advertised when their
corresponding handlers and recovery paths are present.

## Public egress release boundary

All federation HTTP uses one Workers public Internet fetch path, explicit
redirect refusal, bounded JSON bodies and deadlines. The boundary rejects
non-HTTPS, credentials, non-public literal addresses and local names before I/O.
The development configs explicitly set `GSV_FEDERATION_LOCAL_DEVELOPMENT=1`;
this permits only loopback peers when the installation itself has a loopback
origin. It does not permit arbitrary LAN destinations. Production composition
refuses that setting.

The Gateway deployment and Wrangler production configurations enforce
`global_fetch_strictly_public`, eliminating privileged origin fallback.
Service bindings remain separate from federation egress. Cloudflare documents public-only global fetch for Workers
without a privileged origin, and workerd's default Internet network restricts
actual connections to public addresses. This is the connection-time boundary;
an application DNS precheck is not used as its replacement. A self-hosted runtime
must preserve `allow = ["public"]` and must not install a private-network
`globalOutbound` override, or must provide an equivalently constrained egress
service. URL checks are an additional rejection layer; the runtime enforces
the actual connection. CI and two-space acceptance remain required.

References: [Cloudflare binding security](https://blog.cloudflare.com/workers-environment-live-object-bindings/)
[strictly public fetch configuration](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)
and [workerd network configuration](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp).
