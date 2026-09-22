# Participant-owned work requests

An offer is immutable and its wire identity is the requesting ActorRef plus a
request ID. Each participant owns an ordered stream of statements. The requester
can withdraw and review a result; the performer decides whether to accept and
reports execution. The Kernel checks the role independently of the client.

An operation has a stable ID, its participant-local revision, and the revision
of the other stream that its author had observed. Validation uses that causal
view. This preserves a crossed withdrawal and acceptance in either delivery
order. A stop request remains visible until the performer reports cancellation
or a result; it cannot undo a completion. The requesting person's acknowledgement
or dispute is separate from the performer's completion claim. Remote wall-clock
timestamps never select a winning statement.

Each authenticated v2 `work` delivery includes the immutable offer and the
sender's complete prefix, capped at eight operations with 1 KiB notes. These
short lifecycle streams need no separate reconciliation service or cursor.
A later delivery repairs a missing prefix in one bounded transaction, including
an offer whose original delivery was lost. A duplicate or shorter identical
prefix cannot roll back the projection; a reused identity with changed content
fails. The sender cannot write the other participant's stream. Causal references
to operations the other participant never authored fail closed.

The ordinary durable outbox retries the same intent. `contact.request.act` with
`reconcile` sends the current complete local prefix without inventing a new
statement. This is an explicit recovery action after the bounded automatic
retry window. It produces no acknowledgement loop. Lost signed receipts leave
delivery visibly pending or failed until recovery. A later acknowledged prefix
supersedes an older local delivery's attention obligation.

Kernel migration v065 adds the bounded work record to the existing request row.
The request projection and the existing responsibility link commit in the same
SQLite transaction. An incoming offer creates no agent work. Local acceptance
admits an ordinary responsibility; updates advance that same responsibility.
Revoking communication retires its local responsibility, while retaining the
last actual statements instead of claiming that the performer cancelled work.
Terminal records retain the existing 90-day request retention policy.

The v2 feature is negotiated before creating an offer. Legacy requests keep the
v1 transition contract for their lifetime, including participant checks and
unsettled exchanges. V1 updates cannot modify a v2 request. No percentage
progress, workflow language, or remote execution grant is implied by a request.
