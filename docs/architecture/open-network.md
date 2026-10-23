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
any other state as suspended.

## Identity

A Ship's account is a `did:plc` whose handle is the Ship's hostname, such as
`alice.ship.space`. The Kernel creates it on the Ship's first write or upload,
after the profile is published, and the PDS accepts only a hostname that
Accounts routes to the same installation. The Gateway answers
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
