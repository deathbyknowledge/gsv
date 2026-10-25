# The open network

The open network is the [AT Protocol](https://atproto.com) network that Bluesky
and other apps read. A Ship publishes there only what its person chooses to make
public. Messages, contacts, memory and the rest of the Ship stay in the Ship.

```text
signed-in person ─┐                  Kernel                       PDS Worker
                  ├─ atproto.* ──▶  who may publish?   ── PDS ──▶  HostedRepo, one per Ship
Ship, asks first ─┘                 profile published?             did:plc, signed repository,
                                    collection, limits             files
                                                                           │
alice.ship.space/.well-known/atproto-did ──▶ the Ship's DID       HostFirehose ──▶ relays and apps
```

## Repositories

The deployment's PDS Worker, `workers/pds/`, hosts one public repository for
each Ship that publishes. A `HostedRepo` Durable Object named by the
installation ID holds the Ship's `did:plc`, its signed repository and its
files. One `HostFirehose` object numbers every repository's events into the
host's firehose, which relays and apps subscribe to. Public reads are the
standard `com.atproto.repo.*` and `com.atproto.sync.*` XRPC methods; each
reaches the object that holds the repository. `workers/pds/README.md` describes
the repository engine.

The PDS serves an installation's repository only while Accounts reports the
installation active. A retired installation's repository reads as deleted, and
any other state as suspended. A restricted installation keeps its identity, so
the PDS still creates its DID when the Kernel asks, but signs, publishes and
serves nothing for it until it is active again.

## Identity

A Ship's account is a `did:plc` whose handle is the Ship's hostname, such as
`alice.ship.space`. The Kernel creates it on the Ship's first outward act: a
publish, an invitation, a message request or another call to a Ship. The PDS
accepts only a hostname that Accounts routes to the same installation. The Gateway answers
`/.well-known/atproto-did` on that hostname with the DID, which is how apps
verify the handle; a hostname the repository does not name returns 404.

The DID document names two services: `#atproto_pds`, the PDS that holds the
repository, and `#ship`, the Ship's hostname, where other Ships reach it. The
PDS also signs ATProto service-auth tokens with the Ship's key for the Kernel,
only for Ship-to-Ship calls. Each token names the receiving Ship's DID with its
`#ship` service and one `space.ship.*` method, expires after a minute, and
carries a fresh `jti`, so a receiver that remembers them accepts each token
once.

The host's rotation key signs the DID's operations. A recovery key, when the
operator configures one, outranks it.

## Calls between Ships

Ships call each other's `space.ship.*` XRPC methods on the hostname that the
DID document's `#ship` service names, each call with its own service-auth
token. Three budgets bound what callers can make a Ship do. Each refuses a call
with 429 `RateLimitExceeded` and a `retry-after` header:

- The Gateway counts each source's calls to each Ship before any reach the
  Kernel, 250 in 10 seconds at each Cloudflare location (the `SHIP_CALLS`
  rate-limit binding, namespace 7001). A source is the caller's address.
  Workers on other Cloudflare zones all call from one address, so for them it
  is also the zone Cloudflare names in `cf-worker`.
- Once a call's signature verifies, the Kernel counts it against the caller
  DID's budget for that method: 10 a minute for each step of making contact
  (accepting an invitation; sending, accepting or withdrawing a message
  request), 120 deliveries and 480 attachment reads. A contact's own delivery
  and read limits still apply within those.
- Checking a caller the Kernel has not seen before, or one whose signature
  fails against its cached key, means a directory lookup. A Ship makes at most
  60 lookups a minute.

## Contacts from before DIDs

Before the open network, Ships named each other's people by a Ship key and an
account subject. The upgrade keeps those contacts, blocks, message requests and
deliveries in separate tables, and the operator moves them to DIDs once, from
Accounts, in two passes over every active or suspended Ship:

```text
Accounts: identity_moves, scheduled job          Gateway operator entrypoint → Kernel
  survey ──────────────────────────────────▶  its person's old name and DID; the people its rows name
  the operator reviews the totals and applies
  move ──── its person and the DIDs it names ─▶  contact conversations, then one transaction for every row
```

- The survey gives a Ship with contacts its DID, and writes a profile published
  before profiles were records to its repository. It changes no contact.
- The move gives each conversation only the DIDs of its own two people, then
  commits every row and deletes the old identity. A row naming someone without a
  DID here ends: a person on another deployment, or a contact held by an account
  other than the Ship's person. An outgoing message request its recipient never
  received expires for its sender. Deliveries and requests in flight resume on
  their own retry schedule.
- Until its move, a Ship answers other Ships' calls with 503 and a five-minute
  `retry-after`. It refuses new invitations, message requests and sends to a
  contact from before DIDs with "Your contacts are moving to the open network.
  Try again in a few minutes." A contact conversation keeps messages that name
  people the old way out of its immutable archive until the move names them.
- Repeating a finished move changes nothing. Accounts keeps each Ship's DID
  and handle, the old identifiers its rows name, and the counts each pass
  returned, never names or messages.

[Move contacts to DIDs](../how-to/operate-gsv.md#move-contacts-to-dids) is the
operator's procedure.

## Publishing

Publishing is a Kernel syscall; the PDS only stores and serves. The Kernel's
`PDS` service binding carries the `kernel-publish` authority, and the Kernel
addresses its own installation, so no caller chooses one. The rules live at
that boundary:

- Only the signed-in person and their Ship publish. Other processes, other
  accounts and machines are refused whatever their capabilities.
- Nothing publishes while the profile is private.
- The Ship's writes ask the person first unless an approval rule allows them,
  and the Kernel checks the profile again after approval.
- A feature owns its collection: `space.ship.profile` changes only through
  People.
- A file is uploaded before the record that carries it, and is served only
  once a published record references it. An upload that no record references
  within six hours expires.

Ship's own lexicons use the `space.ship.*` namespace. The
[syscall reference](../reference/syscalls.md#open-network-atproto) has the
contract, and [approval rules](../reference/configuration.md#tool-approval-policy)
can allow or block the Ship's publishing.

## The profile

A Ship's public profile is its `space.ship.profile` record, with record key
`self`: a display name, a bio, a picture as a blob, and whether visitors may
send a message request. Publishing uploads the picture and writes the record;
unpublishing deletes it. The Kernel keeps the published record and
its picture, and records the draft revision each publish wrote, so an
unpublished change or a failed publish shows in the editor.

The Gateway renders the published record as the page at `/profile` on the
Ship's hostname and serves its picture from the same host at
`/profile/avatar`, as a sandboxed image. Both ask search engines not to index
them.

A Ship reads another Ship's profile by resolving its handle to a DID, checking
that the DID document claims the handle, and reading the record with
`com.atproto.repo.getRecord` from the PDS the document names. Records come
from any Ship, so a reader ignores fields it doesn't know and reads an unknown
contact policy as closed. The
[profile syscalls](../reference/syscalls.md#public-profiles-and-first-messages)
have the record's limits.

## Deployment

The operator composition runs the PDS once the operator gives it a PLC
rotation key; without one, Ships have no DID and stay off the open network. The
PDS serves at `pds.<domain>` through a route more specific than the Gateway's
wildcard, and Accounts reserves the `pds` handle, so no Ship can claim that
hostname. Only the Gateway's `PDS` binding carries the `kernel-publish`
authority.

The Gateway's `PLC_URL` names the same did:plc directory the PDS registers DIDs
with, so a Ship reads other Ships' DIDs from where its own is registered. The
PDS reaches only that directory, over the public internet even when the
directory runs on the deployment's own zone.

A deployment that admits installation deletion binds the PDS to Accounts as a
deletion owner and lists its `HostedRepo` and `HostFirehose` namespaces for
discovery. The operator's catalog must also cover the PDS bucket's unfinished
uploads and, when they persist, the PDS Worker's logs.

A pull request preview runs the PDS only against a disposable directory that
its workflow names, with a rotation key generated for that preview. It never
registers DIDs with `plc.directory`, which keeps every DID it accepts.

## Deletion

Deleting an installation deletes its Ship's account on the open network.

```text
quiesce   refuse writes, uploads and signatures ─▶ wait for uploads under way
          ─▶ #account { active: false, status: "deleted" } to relays
erase     files ─▶ host directory entry and events ─▶ repository storage
          ─▶ tombstone the DID in the PLC directory
```

While Accounts quiesces the installation, its repository refuses every write,
upload and service-auth signature, waits for uploads already storing their
bytes, and tells relays the account is deleted. Erasure removes the account's
files, its entry in the host's directory, every event it published but the
deletion, and the repository's storage, then tombstones the DID, so the
directory stops resolving it. Erasure resumes where it stopped. The repository
object keeps only a record of the deletion, which refuses a new account for
the installation.

Some of it outlasts erasure:

- The firehose keeps the deletion event until it ages out after 72 hours, so a
  relay replaying the firehose still learns of it.
- The PLC directory keeps the DID's operation log, which names its handle and
  this PDS. The directory's log is public and permanent.
- Cloudflare keeps backups of the erased storage for 30 days. The PDS reports
  that backup as a retained copy until it expires.

A tombstone can't be undone. A DID whose rotation keys no longer include the
PDS's, because it moved to another host, is left as it is.

## When a contact's Ship is gone

A Ship ends a contact on its own side when a delivery to it fails and the
failure proves that the other Ship is gone for good. Two signals prove it:

- The contact's DID has a verified PLC history that ends in a tombstone, as
  erasure leaves a deleted or reset space's DID.
- The address that the DID's document names refused a token addressed to that
  DID, and the address now names another DID whose document claims it and
  serves its own Ship there. After an operator reset, the address reaches the
  person's new Ship, which has a new DID. A host that misroutes a token proves
  nothing when the account its hostname names serves no Ship at that address.

A refused delivery makes the Ship read the DID's document from the directory
again before it judges, so a Ship that moved is reached at its new address
instead. Nothing else ends a contact: an unreachable directory, a timeout, a
server error and a rate limit leave the delivery on its retry schedule, and any
other refusal fails only that delivery. A document that no longer names a
`#ship` service ends nothing either. The DID still names the same person, who
can make it a Ship again, while an ended contact needs a new invitation.

Ending sends nothing to the other Ship. The contact is marked ended, its pending
deliveries fail, its open work requests are cancelled, and its conversation
keeps every message. The two people connect again with a new invitation or a
message request. A Ship notices only when it next delivers something to that
contact.
