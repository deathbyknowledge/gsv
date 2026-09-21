# Process scopes

A scope restricts a newly created ordinary Process and all its descendants. The
Kernel owns the grant, registry binding, expiry and participation allowances.
It does not change the account's capabilities or the ordinary personal Ship.
An approval remains subject to the scope.

A direct signed-in human can supply `proc.spawn.scope`. The immutable policy
contains selected contact conversation IDs and current relationship generations,
separate read/send rights, exact incoming resource references, explicitly supplied
text snapshots, an expiry within seven days, and shared limits for processes,
model generation attempts and outgoing messages. There are at most eight
conversations, sixteen resources, sixteen materials, and 96 KiB per policy.
Retained scopes are capped at 64 per owner and 512 per installation. Orphaned
grants are pruned after a day when another grant is created.

`proc.spawn.idempotencyKey` recovers one exact creation for seven days without
resetting a live Process or reusing a killed pid. Creation with this key takes
no initial prompt: send the first input through the existing idempotent
`conversation.send` path. The Kernel commits the receipt, scope and registry
entry together, then retries identity initialization without replacing later
preferences or history. Receipts are bounded at 256 per owner and 4,096 per
installation. `proc.list.conversationId` finds the owner's existing helpers for
a selected contact thread, including after a browser reload.

The registry captures the scope before Process initialization. A child inherits
the same grant and counters, including when changing its run-as account. Forking
is limited to history already within the scope. IPC and Process history/control
cannot cross into an unrestricted Process or another scope. Account refreshes
preserve the isolated archive home, preventing shared agent homes from becoming
a side door into another person's retained resources.

The dispatcher intersects the account grant with the supported restricted
operations before target routing. Owning handlers repeat resource, conversation,
recipient and generation checks around asynchronous work. Scope identity remains
on a captured request context after Process deletion, so a late request cannot
become unrestricted. Outbound message admission and the message allowance commit
in one Kernel SQLite transaction. Exact retries reuse the committed effect;
every new model-generation attempt consumes an allowance, including repeated
invocations inside one shell command. These limits apply only to explicitly
scoped work.

Restricted native filesystem operations see a closed, read-only `/materials`
mount. There is no fallthrough to R2, account homes, repositories, `/proc`, `/sys`,
or device mounts. Shell network access is disabled; only supported local commands
are offered. CodeMode's nested calls use the same Kernel context. Credentials,
configuration mutation, scheduling, outbound mail, unrelated targets and MCP
are outside this initial scope contract.

Context assembly uses the repository's existing shipped runtime context and
excludes installation overrides, owner and agent standing context, private skills
and unrelated target discovery. No production prompt text is changed. Scoped
inference goes through the Kernel so every new generation checks the current
grant. Resources remain exact references, and resource streams recheck authority
while delivering bytes. Revocation and the ordinary durable expiry task stop the
family's active work; expired/revoked grants deny further effects independently
of cancellation delivery. Already committed outgoing deliveries remain durable.

`proc.scope.get` exposes the policy and used allowances to the owner or its own
scoped family. `proc.scope.revoke` requires a direct signed-in human and the
reviewed revision. Changing a grant requires creating a fresh helper; it cannot
retroactively clean a broader Process history.

People uses this runtime for selected-message assistance, private helper replies
and durable exact-draft review. See social-drafts.md. A scoped contact send
requires a causal reply reference; creating a contact never enables automatic
participation.

## Optional automatic help

A human may create one active automatic helper for a selected, unmuted v2
conversation. The reviewed policy includes the owner's request, permission to
prepare private replies or send as Ship, at most sixteen incoming messages, an
admission interval of at least one minute, and the ordinary shared generation,
process and outgoing-message allowances. There is no automatic renewal. People
defaults to private replies, four incoming messages, a day of access and sixty-
four model requests. These are limits on this explicitly delegated helper, not
global limits on the personal Ship.

Kernel SQLite owns a bounded queue of references to committed incoming human
or human-approved messages. Legacy messages, Ship messages, acknowledgements,
old messages and control events cannot wake it. Queue admission is deduplicated
with the local Conversation projection. A full queue of four pending messages
pauses attention for owner review; already accepted messages at the configured
message allowance remain eligible for delivery. Paused helpers must be stopped
before a fresh allowance is granted.

The existing Kernel scheduler delivers an ordinary typed `social.message`
Process event with a stable deduplication identity, the exact incoming cause,
the owner's request and explicitly untrusted incoming text. Incoming attachments
are not automatically shared. Scope, account, connection generation, mute,
capabilities and model allowance are checked again after the Conversation read.
Retries survive eviction and pause after five unconfirmed attempts. This uses
the existing Process queue and loop; there is no additional agent runtime or DO.

In reply mode, the Kernel derives the outgoing idempotency key from the scope
and admitted incoming origin reference. It admits at most one remote response
for that cause, even if the model invents another key. The cause reservation,
message allowance and ordinary outbox admission commit atomically. A reply to
an undispatched message is refused. Private drafts use the same exact human
approval flow as manual assistance. Muting stops new automatic attention;
revocation, expiry or ending the relationship stops further scoped effects.

CI and the user's two-space trial validate the integrated feature. No local
checks or browser trial have been run by the agent.
