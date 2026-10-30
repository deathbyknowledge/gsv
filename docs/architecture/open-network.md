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

Each repository answers its own public reads from the state Accounts has it
follow, as below: it is served while its installation is active, reads as
suspended while Accounts restricts the installation, and as deleted once
Accounts retires it. Public reads never ask Accounts. The host finds a
repository by DID in its directory once in each Worker isolate, since a DID
names the same repository for as long as it exists, and by handle every time,
since a reset moves a handle to a new repository. A restricted installation
keeps its identity, so the PDS still creates its DID when the Kernel asks, but
signs, publishes and serves nothing for it until it is active again.

Relays hear of a suspension. Once Accounts restricts or reactivates an
installation, it asks the PDS through `PDS_MODERATION` to follow, and the PDS
reads the state back from Accounts. Suspending sends `#account` with
`active: false` and `status: "suspended"`. Reactivating sends `#account`
active, `#identity`, and `#sync` at the repository's head, so a relay that
dropped the account's events while it was suspended fetches it again.
`getRepoStatus` and `listRepos` report the same status. If Accounts changes
the state again meanwhile, the PDS follows that too: it reads the state after
each change until two reads agree. An account created for a restricted
installation starts suspended. A takedown outranks a suspension: the account
reads as `takendown` until the operator restores it, then as `suspended`. If
the PDS can't follow, Accounts keeps the new state and the operator's request
fails; the Ship page's **Try again**, or the same request sent again, tells the
PDS.

Accounts asks the PDS to follow too once it retires an installation, by a
reset or as the first step of deleting it. The repository then reads as
deleted: `getRepoStatus` answers `active: false` with `status: "deleted"`, and
every other read `RepoNotFound`. Relays hear of the deletion only once it
quiesces the repository. If the PDS can't follow, the reset or retirement
fails with the installation retired, and sending it again tells the PDS.

## Identity

A Ship's account is a `did:plc` whose handle is the Ship's hostname, such as
`alice.ship.space`. The Kernel creates it on the Ship's first outward act: a
publish, an invitation, a message request or another call to a Ship. The PDS
accepts only a hostname that Accounts routes to the same installation. The Gateway answers
`/.well-known/atproto-did` on that hostname with the DID, which is how apps
verify the handle; a hostname the repository does not name returns 404. Each
Gateway isolate answers a hostname for a minute from the DID the PDS last gave
for it, so a takedown or a handle moving away shows within a minute; a
hostname the PDS gave no DID for is asked about every time, so a new account
resolves at once.

The DID document names two services: `#atproto_pds`, the PDS that holds the
repository, and `#ship`, the Ship's hostname, where other Ships reach it. The
PDS also signs ATProto service-auth tokens with the Ship's key for the Kernel,
only for Ship-to-Ship calls. Each token names the receiving Ship's DID with its
`#ship` service and one `space.ship.*` method, expires after a minute, and
carries a fresh `jti`, so a receiver that remembers them accepts each token
once.

The host's rotation key signs the DID's operations. A recovery key, when the
operator configures one, outranks it. An owner's recovery key, which the PDS
can list for the Ship's person, ranks first, above both. Within 72 hours of an
operation, a key that the operation before it ranks above the key that signed
it can undo it, by signing another operation on that one. The owner's key can
therefore undo what the host or the operator signs, and neither can undo what
it signs. PLC allows one to five rotation keys, each listed once, and verifies
only P-256 and secp256k1 keys. The PDS changes no owner's key while the account
is taken down or being deleted, and no syscall reaches it yet.

Every change after the genesis goes through one function. It signs the next
operation on the head of the DID's log that the PDS last recorded, and carries
forward every field the change leaves alone. The PDS keeps the signed operation
until the directory has it, so a retry after a lost response submits the same
operation instead of signing another. When the log has moved past the
recorded head, the PDS checks the newer operations as described below: it
builds on a head it adopts, and signs nothing on an identity it steps aside
from, where the change fails with `IdentityChanged`.

The PDS also notices changes it didn't make. It reads the DID's audit log
right before it submits an operation of its own, and when the PLC directory's
feed lists an operation for the DID, but never before a commit or a Ship-call
signature. It walks every operation in force since the newest one it signed or
adopted; an undo can nullify the latest. It trusts the keys that operation
ranks above the host's key. Each later operation must be signed by one of them,
and the trust then moves to the keys that operation ranks above the host's. A
person's undo with their sheet, a sheet they replaced themselves and the
operator's paper-key repair all pass. If every operation passes and the
identity still names this PDS with the account's signing key, the PDS adopts
the head and keeps serving. Otherwise it steps aside and refuses the account's
writes and signatures with `IdentityChanged`, going by what it recorded. The
identity has moved, a key the PDS doesn't trust changed it, or the host's own
key signed an operation the PDS never submitted, so that key has leaked. When
the read before a submission fails, the submission fails with it.

One job reads the directory's feed for the whole host, so its cost follows the
rate of PLC operations across the network, not the number of Ships. Every ten
minutes the worker's schedule has the firehose read the PLC directory's
`/export` after the sequence number where the last run stopped, a page of up to
1,000 operations at a time and at most 30 pages a run, and keep only the DIDs
the host holds. It wakes only the repository object of a DID the feed lists.
That object reads nothing when every listed operation is one it signed or
adopted: it records each operation's CID before it submits the operation. The
first run begins 72 hours back, PLC's window for undoing an operation, so the
feed sees every change a key can still undo. A change older than that waits for
the host's next operation of its own, whose read still refuses to build on it,
or for the operator's check. When the directory answers 429, the feed waits as
long as its `Retry-After` asks, or backs off from ten minutes, doubling up to
two hours, and then reads the page it stopped in again. Any other failure is
kept for the operator and fails the run, and the next run reads on from the
last page it finished. A host that holds no identities reads nothing.

The PDS records each adoption and step-aside with the head, the operation that
decided it and the key that signed it, for the Kernel or the operator to read
later; it tells nobody yet. The feed also keeps, for the whole host, the last
100 step-asides it found and the last 100 undone leaks. An undone leak is an
operation the host's key signed that the PDS never submitted, which a person's
sheet or the paper key later nullified. The PDS follows the undo, so the walk
alone would lose that leak; the nullified operations in the log keep it,
whether the undo came before the feed listed the leak or after.
`npm run pds:identities -- audit` prints what the feed has found, how far it
has read and why its last run failed, if it did, and reads no identity's log.
With `--did`, it has the PDS read that one identity's log again.
[Audit Ships' identities](../how-to/operate-gsv.md#audit-identities) is the
procedure.

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

## Lexicons

Each `space.ship.*` method and record is defined by a Lexicon v1 document in
`lexicons/space/ship/`, one file per NSID: the six methods Ships call on each
other and the `space.ship.profile` record. The lexicons are the contract. The
SDK's NSID constants, validators and types are generated from them, as are the
limits a Ship checks before it sends, and the Kernel and web import those from
`packages/gsv/src/protocol/generated/ship-lexicons.ts`.

```text
lexicons/space/ship/*.json ────────────┐
                                       ├─ npm run protocol:generate ─▶ generated/ship-lexicons.ts
tools/protocol/ship-lexicon-rules.mjs ─┘                                NSIDs, limits, zod/mini validators, types
```

The validators read Lexicon as its specification does. String lengths count
UTF-8 bytes and graphemes; `enum` is closed while `knownValues` only advises;
the `did`, `handle`, `at-uri`, `datetime` and `cid` formats are checked, a CID
being CIDv1; a blob must match its `accept` types and `maxSize`. Lexicon
objects are open, so methods and records alike read away fields their lexicon
doesn't declare rather than refusing them, and a later version can add one.

Each method's lexicon declares the errors it answers with, beyond those any
XRPC method may answer with, such as `InvalidRequest`, `RateLimitExceeded`
and service auth's `BadJwt`. `npm run protocol:check` walks each handler the
Kernel registers in `kernel/ships/methods.ts` through the calls it makes, and
fails when one can answer with an error its lexicon doesn't declare.

Some checks Ships make can't be written in Lexicon, so
`tools/protocol/ship-lexicon-rules.mjs` adds them, and the field's lexicon
description states them for other implementations. Names, message text,
filenames and transcriptions count UTF-16 code units. Resource IDs and request
kinds follow patterns. A delivery's payload is chosen by its `kind` rather than
a `$type`. A file's duration is a fractional number of seconds. A request's
details are at most 32 KiB as JSON.

The rules file also names the limits a Ship checks before it sends, such as
`MAX_FEDERATION_MESSAGE_BYTES`, the most UTF-8 bytes a message's text may hold.
Each is the lexicon's own `maxLength` or `maximum`, or the number a rule checks,
so the sender's check and the receiver's can't drift apart.

To change a lexicon:

1. Edit its file. Ships already running keep validating with the version they
   shipped. A record or a method can gain optional fields, because readers
   drop what they don't know. Ships from before methods dropped undeclared
   fields still refuse them, so a sender can't count on a new method field
   reaching a Ship until those Ships are gone. No limit can tighten, no field
   can become required, and a method's new error must be declared.
2. Run `npm run protocol:generate` and commit the regenerated modules with the
   lexicon. It also writes the list of lexicon files the PDS imports and
   publishes, `workers/pds/src/gsv/generated/ship-lexicons.ts`, which changes
   only when a lexicon is added or removed.
3. `npm run protocol:check` fails while a generated module is stale. It also
   fails when code writes a `space.ship` NSID as a string, so import the
   generated constant instead.
4. Once the deployment is out, [the lexicon account](#the-lexicon-account)
   publishes the changed lexicon within ten minutes.

## Contacts from before DIDs

Before the open network, Ships named each other's people by a Ship key and an
account subject. Every contact is now named by DID, and an active contact always
has one. A contact that ended before DIDs keeps its conversation, marked ended,
without a DID; to talk again, the two people connect anew. Messages archived
before DIDs read without the old identifiers. A message from before DIDs whose
author has no DID here keeps its text, but a reply can't point to it. An
invitation code from before DIDs is refused with a request for a new one.

A deployment whose Ships are from before the open network moves their contacts
on an earlier revision before it updates; see
[Update an existing deployment](../how-to/deploy-with-alchemy.md#update-an-existing-deployment).

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
- A feature owns its collection: `space.ship.profile` and
  `app.bsky.actor.profile`, the profile as Bluesky shows it, change only
  through People.
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

While the profile is public, the repository also holds it as Bluesky shows
it: an `app.bsky.actor.profile` record with record key `self`, which Bluesky
and other apps read from relays. The Kernel writes it in the same commit as
`space.ship.profile`, and unpublishing deletes both in one commit; a delete
of either record already gone is dropped and the rest commits. The copy
carries the display name, the bio, the picture and the profile page as its
`website`. Bluesky allows a name of 64 graphemes and 640 bytes and a bio of 256
graphemes and 2,560 bytes, so a longer one is cut between graphemes and ends
with an ellipsis, while the Ship's record keeps it whole. Bluesky shows only
PNG and JPEG pictures, so the copy leaves out a WebP picture; People saves new
pictures as JPEG, or PNG when they have transparency. Both records reference
one uploaded file. The Kernel keeps the copy it wrote and checks it at each
sign-in and whenever it reconciles the owner's existing personal agent, as the
first message to their Ship from any surface after the Kernel starts does. A
profile published before Ships kept one gets its copy then, without delaying
that message, and a check that finds the copy current asks the PDS nothing.

Bluesky shows the copy once relays crawl the deployment's PDS. The Ship
doesn't read Bluesky, so follows, replies and messages there don't reach it,
and a person who already has a Bluesky account has the Ship's as a second one.

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

## Takedowns

The operator can take down a Ship's whole account, one of its records or one
of its files on the PDS that hosts them. This is narrower than suspending the
Ship in Accounts, which stops everything it does. Takedowns follow
`com.atproto.admin.updateSubjectStatus`, as Bluesky's moderation service uses
it: a takedown names a `repoRef`, a `strongRef` or a `repoBlobRef`, and
restoring is the same call with `applied: false`.

```text
Accounts Ship page ── audit event, reason ── PDS_MODERATION ──▶ HostedRepo: takedowns
                                             operator-moderation       │ every public read honours them
People, atproto identity ◀── Kernel ◀── PDS (kernel-publish) ◀─────────┘
/profile, /.well-known/atproto-did ◀─┘
Accounts ── OPERATOR_GATEWAY: operatorTakedownsChanged ──▶ Kernel ── Bluesky's copy ──▶ HostedRepo
```

The PDS keeps each takedown with the Ship's repository and honours it in every
read it serves:

- An account taken down answers repository reads with `RepoTakendown` and
  reads as `takendown` in `getRepoStatus` and `listRepos`. Relays receive an
  `#account` event saying so, and the Ship's hostname stops naming the DID
  within a minute. The PDS refuses the Ship's writes, uploads and
  service-auth signatures, so the Ship publishes nothing and can't call other
  Ships. The Kernel takes that refusal as final: a message, message request or
  acceptance it was sending fails at once instead of retrying, and its person
  reads why. Other Ships can still call it, so its contacts' messages keep
  arriving. Restoring the account tells relays it is active again and sends its
  identity and current commit, unless the Ship is suspended: then it tells
  relays that the account is suspended.
- A record taken down reads as missing: `getRecord` answers `RecordNotFound`
  and `listRecords` leaves it out. Its commit stays in the signed repository,
  so `sync.getRepo` and the record's proof from `sync.getRecord` still verify,
  as on Bluesky's PDS.
- A file taken down reads as missing from `getBlob`, and stays listed in
  `listBlobs`.
- A takedown stays with its subject until the operator restores it. A record
  the Ship edits, deletes and writes again stays hidden, and so do the same
  bytes uploaded again. Bluesky's PDS instead forgets a record's takedown
  once the record is deleted, so the same record written again is public.

Bluesky reads the repository's commits, not the PDS's takedowns, so a
takedown doesn't remove what Bluesky already shows, and a record written again
while it is down would reach Bluesky. The Kernel keeps the Bluesky copy of the
profile from showing what the host hid. It reads the takedowns as it publishes:
while the account, the profile record or the copy is down, it deletes the copy
instead of writing it, and while the picture's file is down it leaves the
picture out. Each takedown and restore also reaches the Ship at once. Once the
PDS holds the change, Accounts calls `operatorTakedownsChanged` on its
`OPERATOR_GATEWAY` binding, which reaches only an active or suspended Ship. The
Kernel reads the takedowns and, under the lock its publishing takes, deletes or
rewrites the copy in one commit. It answers only `removed`, `updated` or
`unchanged`. While the whole account is down the PDS refuses the Ship's writes,
so the copy stays as it is; relays hide the account meanwhile, and restoring
the account tells the Ship again. If the Ship can't be told, the change still
stands and its audit entry says `unreachable`. Taking the subject down again
tells the Ship again, and a restore it missed reaches Bluesky at the person's
next sign-in or message.

The Ship's own pages honour the same takedowns. For each request to `/profile`
or `/profile/avatar`, the Kernel asks the PDS what it has taken down rather
than keeping a copy that could fall behind. The page answers 404 while the
account or the profile record is down, leaves out a picture whose file is
down, and answers 503 while the PDS can't say. `/.well-known/atproto-did`
claims no handle for an account that is down, as Bluesky's PDS does. Other
Ships read profiles from the PDS, so `profile.resolve` finds no public profile.

Accounts records each takedown and restore in the operator audit log, with the
operator's reason and what became of the Bluesky copy. A takedown requires a reason, and the PDS keeps the audit
event's ID as the takedown's `ref`. The person sees each takedown and its
reason in People, and their Ship reads them with `atproto identity`.
[Take down what a Ship publishes](../how-to/operate-gsv.md#take-down-what-a-ship-publishes)
is the operator's procedure.

## Request reports {#request-reports}

A person can report an incoming message request to their operator. Reports
stay with the deployment: nothing goes to the sender's host or a moderation
service.

```text
People ── approach.report ──▶ Kernel ── REQUEST_REPORTS ──▶ Accounts: request_reports
                              declines, records reported_at   kernel-report      │
Accounts Reports page ◀──────────────────────────────────────────────────────────┘
  ├─ Dismiss ── audit event ──▶ closes the report
  └─ Take down ── PDS_MODERATION ──▶ the sender's account, when this host holds it
```

The Kernel files a report only when the person chooses Report, and only for a
request they received whose message arrived, until they accept it. Ship can't
report, because it doesn't read incoming requests. Each owner may report 20
requests a day; an attempt counts even when filing fails. The Kernel names its
own installation and the request, so Accounts keeps one report per request
however often it is filed. It declines a request that is still waiting and
records when it was reported; the sender isn't told.

Accounts stores the sender's DID and handle, the category, when the request
arrived and when it was reported. The sender's name and first message, exactly
as the person read them, are stored only when the person includes them. The
Accounts cron erases them 90 days after the report closes; the rest of the
report stays until the reporting installation is deleted.

The operator closes a report by dismissing it or by taking the sender's whole
account down, which closes every open report of that sender. A takedown is
offered only when the deployment's PDS holds the sender's DID, and it runs
under the same audit as the Ship page's. An operator action names its report
in its audit detail from the moment it is written, so the report's trail lists
every action on it, failed attempts included. Each closed report also keeps
the ID of the audit event that closed it.
[Review reports](../how-to/operate-gsv.md#review-reports) is the operator's
procedure.

## Deployment

The operator composition runs the PDS once the operator gives it a PLC
rotation key; without one, Ships have no DID and stay off the open network. The
PDS serves at `pds.<domain>` through a route more specific than the Gateway's
wildcard, and Accounts reserves the `pds` handle, so no Ship can claim that
hostname. Only the Gateway's `PDS` binding carries the `kernel-publish`
authority, and only Accounts' `PDS_MODERATION` binding carries
`operator-moderation`, which takes down and restores.

The Gateway's `PLC_URL` names the same did:plc directory the PDS registers DIDs
with, so a Ship reads other Ships' DIDs from where its own is registered. The
PDS reaches only that directory and the [relays](#relays) the operator names,
over the public internet even when one of them runs on the deployment's own
zone.

The PDS's `com.atproto.server.describeServer` answer names the operator's public
contact address and links its privacy policy and terms of service when the
operator gives them. Relays and other services read it to learn who runs the host.

A deployment that admits installation deletion binds the PDS to Accounts as a
deletion owner and lists its `HostedRepo` and `HostFirehose` namespaces for
discovery. The operator's catalog must also cover the PDS bucket's unfinished
uploads and, when they persist, the PDS Worker's logs.

A pull request preview runs the PDS only against a disposable directory that
its workflow names, with a rotation key generated for that preview. It never
registers DIDs with `plc.directory`, which keeps every DID it accepts.

## Relays

Bluesky and other apps don't read each host. They read a relay, which follows
the firehoses of the hosts it knows and serves them as one. A relay starts
following a host when the host asks it to with
`com.atproto.sync.requestCrawl`, naming its hostname. It first checks that the
host answers `com.atproto.server.describeServer`, then reads the host's
firehose: from its live end the first time, and from the last event it read
when it follows the host again. A relay that loses the firehose too often stops
following the host until the host asks again. The firehose keeps 72 hours of
events, so a relay that comes back within that time misses none. One
subscription replays at most 1 MiB before the firehose closes it with code
1013, and the relay resumes from the last event it read when it reconnects.
The firehose holds at most 64 subscriptions and refuses more with HTTP 429
`RateLimitExceeded`, so reconnecting relays can't exhaust the memory every
repository shares.

```text
every ten minutes ─▶ HostFirehose: which relays are due?
                       │ requestCrawl { hostname: "pds.<domain>" }
                       ▼
                     relay ── describeServer, then subscribeRepos ──▶ PDS

each run after a relay first accepts, until every account is introduced:
  HostFirehose ── #account, #identity, #sync for the next 200 accounts ──▶ relays
```

The operator names the relays with `GSV_PDS_RELAYS`, such as
`https://bsky.network`. A deployment names none by default, and then the PDS
asks no relay. Once it names some, the PDS checks every ten minutes which of
them are due:

- A relay it hasn't asked is asked at once.
- A relay that accepted is asked again only once the host has events it didn't
  have then and twenty minutes have passed, as Bluesky's PDS does. A relay that
  dropped the host is asked back soon after the host's next event, and a quiet
  host sends nothing.
- A relay that refused or couldn't be reached is asked again after forty
  minutes, and each further refusal in a row doubles the wait, up to six hours.

The firehose keeps each relay's last answer, and writes that record only when
an answer changes it. It forgets a relay at the first run after the deployment
stops naming it, so a relay named again after that is asked at once and
introduced to the host's accounts again. With no relay named, a run writes
only to forget the relays the firehose still remembers, so the runs after that
write nothing. The schedule runs on every deployment with a PDS, since it also
reads the PLC directory's feed for the host's identities. A relay that refuses
or can't be reached is a warning in the PDS Worker's logs that names the relay
and, for a refusal, the HTTP status and the XRPC error. The request carries
only the host's hostname.

A relay checks every event as sync 1.1 describes, and a Ship's repository sends
what it needs: `#identity`, `#account` and `#sync` when the account is created,
and each `#commit` with the previous data root and the blocks that undo its
operations, so the relay checks the commit without the repository. The relay
reads an account's status from `getRepoStatus` and a whole repository from
`getRepo`, and it requires the DID's PDS endpoint to name the host it follows.

A relay reads a host's firehose from its live end the first time, so on its
own it would learn of an account that existed before it joined only with that
account's next event. The host introduces those accounts instead. From its
first run after a relay accepts, when the relay is following the firehose, it
sends what creating each active account sent: `#account`, `#identity`, and
`#sync` at the repository's latest commit, which tells the relay and the apps
that read it to fetch the repository at that commit. The firehose keeps what
that `#sync` carries for each active repository as it sequences the
repository's commits: the commit's revision and a CAR holding only its signed
commit block, under 300 bytes a repository. Introducing an account therefore
reads only the firehose's own storage, and wakes no repository object. The
firehose drops an account's commit when the account is taken down, suspended
or deactivated, and when it erases a deleted repository; reactivating an
account announces its head with `#sync` again. A run introduces at most
200 accounts, in DID order, so a host with 10,000 accounts takes 50 runs, a
little over eight hours. The introduction covers the accounts the host held
when it began; accounts created since reach the relay live. Taken-down and
deleted accounts aren't introduced. Each batch commits with how far the relay
has got, so each relay hears each account once, across runs and restarts of
the firehose, and again only when the deployment stops naming it and then
names it again. The firehose is one stream, so relays already following hear
the introduction too, and already have each account at that head.

A firehose created before it kept commits fills them in once, the first time it
starts with them, from the frames it still retains: each active repository's
newest `#commit` or `#sync` from the last 72 hours. It reads nothing from the
repository objects. A repository with neither is introduced with `#account` and
`#identity` alone, and relays learn its head from its next commit.

Relays limit how many accounts they follow on each host. The reference relay,
which Bluesky operates, follows 100 accounts on a new host by default and drops
the events of any past that until its operator raises the host's limit, so an
account past the limit misses its introduction too. It also takes at most 50
new hosts a day.
[Announce the host to relays](../how-to/operate-gsv.md#announce-the-host-to-relays)
is the operator's procedure.

## The lexicon account

The lexicons are published on the network, so another implementation can
resolve a `space.ship` NSID to its schema. Resolution reads the `_lexicon` TXT
record of the NSID's authority domain, which for every `space.ship.*` NSID is
`_lexicon.ship.space`. Its `did=` value names the account whose repository
holds each lexicon as a `com.atproto.lexicon.schema` record keyed by its NSID.

```text
_lexicon.ship.space           TXT "did=did:plc:…"   the account that speaks for space.ship.*
_atproto.lexicons.ship.space  TXT "did=did:plc:…"   that account's handle
did:plc:… ─▶ pds.ship.space ─▶ com.atproto.lexicon.schema/space.ship.sendMessage, …
```

That account belongs to the deployment, not to a Ship: it has a DID, a handle
and a repository on the deployment's PDS, and no installation, Kernel or
person. The operator names its handle with `GSV_PDS_LEXICON_HANDLE`, which is
`lexicons.ship.space` in production and `lexicons.staging.ship.space` on
staging. Accounts reserves the `lexicons` handle, so no Ship can claim it, and
a deployment refuses a handle one label below one of its domains unless it is
`lexicons.<domain>`. The handle verifies by its `_atproto.<handle>` TXT
record; HTTP on that hostname answers with the Gateway's 404. Only
production's DID goes in `_lexicon.ship.space`, so staging's account never
speaks for `space.ship`.

The PDS holds the account in a `HostedRepo` object named `operator/lexicons`.
No installation ID can match that name, so the Kernel's binding can't address
it, deletion discovery reads it as holding no installation's data, and its
public reads don't ask Accounts.

Creating the account registers its DID with the PLC directory, which keeps it
for good, so deploying never creates it. The operator does, once for each
deployment, with `npm run pds:lexicons -- create`. Each request the command
sends is a token that the host's PLC rotation key signs for the PDS's origin
and that lasts a minute, so only whoever holds the key that registers every
Ship's DID can create the account or publish. `create` refuses a handle other
than the deployment's, a handle Accounts routes to a Ship, and a second account
once the deployment has one; repeating it answers with the account it made.

The first publish is the operator's too, with `npm run pds:lexicons --
publish`. After it, the PDS checks every ten minutes and publishes, in one
commit, each lexicon whose record differs from the deployed release's. It never
deletes a record, so a lexicon a later release drops stays published.
`npm run pds:lexicons -- status` lists the lexicons waiting to go out. Like a
Ship's account, it refuses writes while the host has it taken down: `publish`
answers `RepoTakendown`, and the schedule writes nothing and logs that
publishing is held until the takedown is lifted.

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

A tombstone ends the identity wherever it's hosted. Only a key ranked above
this PDS's, such as the owner's recovery key or the operator's, can undo one,
and only within 72 hours. Erasure therefore leaves alone a DID that has moved to
another host: one whose `#atproto_pds` names another PDS, or whose rotation keys
no longer include this PDS's.

## When a contact's Ship is gone

A Ship ends a contact on its own side once it can prove that the other Ship is
gone for good. Two signals prove it:

- The contact's DID has a verified PLC history that ends in a tombstone, as
  erasure leaves a deleted or reset space's DID.
- The address that the DID's document names now names another DID whose
  document claims it and serves its own Ship there. After an operator reset,
  the address reaches the person's new Ship, which has a new DID.

The Ship looks for these signals only when its person messages, opens or lists
contacts. Nothing scans contacts in the background.

| When | What the Ship checks |
|---|---|
| A delivery to the contact is refused | It reads the DID's document from the directory again. A tombstone ends the contact. A takeover counts only if the address refused a token addressed to that DID. A host that misroutes a token proves nothing when the account its hostname names serves no Ship at that address. |
| The person, or their Ship, reads the contact's conversation or deliveries | It checks after the read has answered, at most once an hour for each contact. It reads the DID's document again if its copy is an hour old, and resolves the address the document names as a handle. Before a takeover ends the contact, it reads the document again, in case the Ship moved. An ended contact is broadcast as `contact.changed`. |
| The person lists their contacts | It makes no lookup. It ends only the contacts whose DIDs its directory cache already knows were deactivated. |

The directory cache keeps a tombstone it reads in place of the DID's document,
so a contact can end on what an earlier lookup found. Like a document, the
tombstone is read again a day later if the DID is still in use.

Each check reads the DID's document before it judges a takeover, so a Ship that
moved is reached at its new address instead. Nothing else ends a contact. An
unreachable directory, a timeout, a server error and a rate limit leave a
delivery on its retry schedule, and any other refusal fails only that delivery.
A document that no longer names a `#ship` service ends nothing either. The DID
still names the same person, who can make it a Ship again, while an ended
contact needs a new invitation.

Ending sends nothing to the other Ship. The contact is marked ended, its pending
deliveries fail, its open work requests are cancelled, and its conversation
keeps every message. The two people connect again with a new invitation or a
message request.
