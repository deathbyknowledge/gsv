# First-contact wire contract

This is the implementation contract for batch 3 of
[RFC 0002](../../engineering/rfcs/0002-social-model.html). Public admission stays
disabled until its storage, recovery, quotas, UI and two-space CI flow are
implemented. The existing private invitation protocol remains supported.

## Ownership and identities

An approach has an immutable origin `(sender ActorRef, approachId)`, one intended
recipient ActorRef, an origin message ID, a fixed expiry and a fingerprint of its
approved text and participants. Each installation assigns its own local account,
contact reservation and Conversation ID. Those local identifiers never cross
the wire. Replays with different approved content are rejected.

Creating an approach is a direct human action. The person selects one verified
profile, reviews their own public display name and writes the first message.
Sending does not require publishing their own profile. The outgoing approved
display name is explicit; a login username is not silently used as public text.
The recipient's current published snapshot must allow requests at admission.
Later unpublishing stops new requests; an already received request still needs
its own accept, decline or block decision.

Both ends retain that first message in an ordinary handler-free contact
Conversation. A contact reservation is an owned local identifier, not an active
transport grant. Acceptance attaches the same Conversation and message IDs to
the relationship. Where a previous relationship exists, retain its local IDs
and history. No additional Conversation kind, index service or Process is needed.

## Bound pairing using existing primitives

The sender prepares fresh 32-byte authorization material when committing the
approach. Its hashed invitation lookup is bound to the exact sender, recipient
and approach. Only the intended recipient can claim it. The private setup
artifact travels inside the authenticated request body and is never returned
by list/history APIs, rendered in the UI, placed in a URL or included in logs.
Ordinary v1 acceptance refuses a bound invitation.

The recipient's human acceptance creates a durable pairing attempt before
network work. Its claim signs a dedicated v2 domain containing both actors,
the approach identity, the setup artifact and the fixed attempt identity.
A signed public Ship document alone is not proof that the claimant controls
the key; the signature over this exact claim is required. The issuer checks
the bound recipient, current approach decision, invitation and actor block
again in the claiming transaction.

The issuer uses existing contact-secret derivation, generation allocation and
durable invitation receipts. It commits one generation, local relationship and
claim outcome atomically. A duplicate claim returns that exact outcome;
another claimant, participant, approach or superseded generation is refused.
The recipient verifies the signed outcome against its owned attempt before
committing the same generation and its preserved local Conversation.

The recipient then sends a signed confirmation for that generation. Until
confirmation arrives, the issuer shows connection setup as pending and retains
outgoing sends durably without dispatching them. This closes the interval where
the issuer has committed but the recipient has not installed its route yet.
Confirmation is an idempotent durable operation. It does not create another
generation, human notification, message or responsibility.

The recipient may receive the first successful claim response after the issuer
has already committed it. It must retry the same attempt after a lost response;
neither a timeout nor restart creates another invitation or generation. The
original artifact is retained only while admission/claim recovery needs it.
Committed setup records retain hashes and the exact replay outcome through the
eight-day receipt window. Pending approaches expire after 30 days. No artifact
can authorize a different actor, survive a block, or reactivate a superseded
generation.

Private invitation lists and their rate budgets exclude these internal bound
invitations. Withdrawal uses the approach action, not the private invitation
cancel API, so the decision and its setup authority change atomically.

## Admission and outcomes

An envelope has a dedicated v2 domain, a fresh signed Ship document, fixed
origin/recipient metadata and a signature covering the envelope. Authenticate
before treating its contents as an actor's request. For an unpaired actor,
bounded public discovery verifies that the declared origin serves the same
Ship key; a claimed origin in a self-signed document is insufficient.
All resolution uses the existing public-only egress boundary. No linked page,
avatar or attachment is fetched on admission.

The Kernel first reserves a bounded intake row, then commits the first message
idempotently to its Conversation and records the outcome. Recovery resumes an
unfinished append. The intake receipt means the request was durably received;
it does not mean accepted, read or authorized as work. An incoming request
creates no Process, r12y promise or model wake.

Decline and block are local decisions. Public refusal is generic and does not
disclose the reason or export the block list. A withdrawal received before the
issuer's claim transaction closes that invitation. If the issuer already
committed acceptance, withdrawal reports that settled acceptance and offers
ordinary disconnection instead of pretending the remote transaction never
happened. Local block always revokes current authority, regardless of a delayed
claim, confirmation, message or receipt.

Retryable delivery is separate from the human decision. `pending`, `accepting`,
`accepted`, `declined`, `withdrawn`, `expired` and `blocked` are retained local
facts; uncertain delivery cannot be labelled completed. Sender-visible state
never exposes a recipient's private mute, block reason or unread position.

## Initial bounds and retention

The concrete admission budgets are independent of established message delivery:

| Boundary | Initial limit |
| --- | --- |
| Public JSON and parsing | Existing 128 KiB maximum; 120 ingress attempts/minute/installation before identity work |
| First-message body | Existing 32 KiB UTF-8 text maximum; no resources |
| Participant pair | One unresolved approach in either direction; crossed sends retain the outgoing intent and return a retryable collision until one person withdraws it |
| Pending incoming | 250 per recipient, 1,000 per installation |
| Pending outgoing | 100 per owner, 500 per installation |
| Newly admitted incoming | 60/hour and 100/day per recipient; 500/day per installation |
| Newly created outgoing | 10/day per owner, in addition to ordinary authenticated syscall controls |
| Per authenticated sender/recipient | 5/day; rotating keys still consume recipient and installation limits |
| Pending request | 30 days, followed by a visible expired outcome |
| Settled replay outcome | At least 8 days after termination; no expiry while required recovery is unresolved |
| Retained intake rows | 5,000 per owner, 20,000 per installation, separately from Conversation history |
| Temporary first-message text | 64 MiB per installation; incoming text leaves Kernel storage after its canonical append |

All counters and reservations commit with the admission decision. Full capacity
rejects new intake with bounded retry information; it never evicts an established
message, committed acceptance or unresolved recovery record. Pagination is
keyset-based. Private invitation, established inbox/outbox and public-intake
budgets remain distinct.

At the incoming pending installation ceiling, first-message text is at most
31.25 MiB across 1,000 existing-class Conversation objects. The outgoing ceiling
adds at most 15.625 MiB. CI at `84e8827b` measured a fresh Conversation at
126,976 SQLite bytes and one containing a maximum-size first message and its
search index at 176,128 bytes. At 1,000 such objects that is about 168 MiB,
before provider accounting and other owned data. A Kernel fixture containing
1,000 maximum-size incoming append reservations grew from 1,007,616 to
35,717,120 SQLite bytes. These are fixture measurements, not production costs;
object/schema overhead is material and source-text size alone understates it.
The capacity fixtures enforce admission limits without evicting owned records.
Expiry, replay, interrupted cleanup and the complete two-space flow must also
pass CI before release.

Terminal unaccepted requests have an explicit retention/cleanup path. Clearing
their intake rows alone is insufficient: their Conversation, index and temporary
setup material remain owned resources. Cleanup must fence late appends and
claim work and must never delete an accepted relationship's Conversation.
Accepted message history follows normal Conversation retention. A terminal,
unaccepted request is retained for eight days for receipt recovery, then its
unpromoted Conversation content and search index are discarded. A durable
fence rejects late appends. Deleting rows is not a claim that SQLite pages or
all object overhead are immediately reclaimed. Cleanup failures retry without
removing the owning intake record. No cleanup may remove a promoted thread.
