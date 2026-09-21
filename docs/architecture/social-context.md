# Selected shared relationship context

Shared context is a local, attributed projection from sources the human chooses.
It does not export the address book, blocks or mutes. Looking up a subject reads
the Kernel cache only. It never contacts every source or follows mentioned actors.
No statement, connection, subscription or introduction creates Process authority.

## Publication and consent

A publisher owns a bounded set of signed connection, recommendation and advisory
records. The source ActorRef, subject ActorRef, stable assertion ID, revision,
text/category, audience and expiry are explicit. A recommendation or warning
identifies who made it; a signature does not establish its truth. Private aliases
and account names are not copied into a publication automatically.

The first audience rule is the publisher's active direct contacts who explicitly
subscribe to that record kind. It is not public discovery. A connection describes
the publisher's own relationship with the subject and needs both endpoints'
signed approval of the exact record, audience and expiry. Accepting a conversation
does not give that approval. Either endpoint can revoke its approval. Revisions
that change the disclosed connection require fresh consent.

Approval includes a signed display lease shorter than 24 hours, with a separate
monotonic lease revision. The approving endpoint renews that proof only while
the same local human approval, statement revision and contact generation remain
active. Revocation stops renewal immediately. A publisher cannot extend another
person's proof by renewing its own page lease; recipients verify both bounds.
An unavailable approving endpoint therefore pauses disclosure when its last
proof expires. These renewals are deterministic Kernel maintenance, without a
Process or model call.

Selected evidence is a quoted copy of explicitly chosen committed messages,
including origin references where available. It carries the publisher's
attribution. It does not grant access to the underlying conversation, private
files or attachments; fuller evidence can be sent separately through the normal
reviewed report flow. Publication review shows the exact quote and audience.

## Synchronization and withdrawal

Subscriptions are local, per source and per kind. The source authenticates the
current contact generation on every page. Opaque encrypted cursors bind the
viewer, source, kinds, policy, snapshot watermark, position and expiry; source
metadata cannot become a caller-selected cursor or a count of hidden edges.

A bounded snapshot is staged before replacing the active cache. Subsequent
revision deltas cover changes during that snapshot. The source retains current
versions and withdrawal revisions, rather than an unbounded copy of every
historical payload. Expired cursors resnapshot. Each response has a finite display
lease of at most 24 hours, further limited by the assertion and consent expiry.
Disconnected recipients stop displaying expired context.

The publisher remembers recipients of disclosed records and queues durable
withdrawals to them. Removing an audience member or ending a connection also
invalidates the local projection of that source. A withdrawal or subscription
change advances the local sync generation, so an in-flight older response cannot
restore removed context. An unsubscribed source has no visible rows immediately;
its bounded cache is then deleted. Copies deliberately exported by a recipient
cannot be recalled.

## Initial budgets and ownership

Kernel SQLite owns publication, approvals, subscriptions, viewer receipts and
the cache. Existing federation identity, authenticated transport, durable outbox
and Kernel scheduler own signing, retry and background work. There is no new
Durable Object or shared directory.

Initial bounds are 128 assertions per owner / 512 per installation, 32 selected
sources per owner / 64 per installation, 128 visible records per source, and
4,096 cached records / 16 MiB of cached payload per installation. Individual
signed records fit within 8 KiB. Sync and fanout use bounded pages and durable
continuations. Capacity failures leave the last permitted, unexpired projection
visible with a clear sync state; they do not silently truncate it into a claimed
complete snapshot.

## People presentation

Person details and request review show a compact “Shared with you” section with
the selected source, its exact statement and freshness. Opening a source reveals
only its chosen, consented connections and published statements. Subscription
controls name each kind, show what will be cached and provide a stop action.
Publication and connection-consent review have their own explicit forms.

Introductions use deliberate ordinary messages in separate conversations.
The intermediary asks the proposed recipient first and reviews the selected
context before forwarding it. Recipients still decide whether to engage. There
is no automatic group, pairing, resource access or inherited trust.

The context paths and People review screens are implemented on the feature
branch. Introductions use reviewed ordinary messages: ask a mutual contact, ask
the proposed recipient first, then select that person's human or approved reply
and review the agreed introduction separately for each conversation. The human
confirms what both people agreed to disclose; no model interprets “yes” as a
permission grant. Private aliases, source replies and files are not copied into
the draft. An optional public profile is resolved only for the deliberately
selected pinned contact. The separate scoped-assistance batch remains in progress.
CI and maintainer acceptance, rather than this document, establish validation.
