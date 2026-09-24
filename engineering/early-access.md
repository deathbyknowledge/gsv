# Invite onboarding

## Browser signup and cached plan values

Browser signup owns the same invite, email verification, handle selection, and
resume journey as desktop. Its primary action is to create a space; opening an
existing space remains available. The shared welcome controller and screens
own the journey, while each host owns credential storage and navigation. The
browser stores its pending flow atomically in IndexedDB and enters the existing
space setup screen with a fragment-only onboarding capability.

Accounts serves the browser entry at `/owner/signup/`; a managed signup hostname
may redirect there. The page uses the shared auth scene and fields. Native
enrollment, plan administration, and billing controls remain in their existing
surfaces. Signup never inserts or sends a conversation message.

Plan values are cached for five minutes per installation. Each service still
checks current lifecycle and operational admission for every request, and owns
its authoritative usage counters and reservations. Inference routing and its
operational switch are live reads, separate from the cached commercial limits.
Expired plan snapshots cannot admit new work.

The desktop welcome screen gets a person into an existing space or creates one
from an operator-issued invite. Accounts owns verified owner identity, invite
redemption, handle allocation, and resumable setup. The Kernel continues to own
local credentials. A global owner session does not grant ordinary Kernel access.

## Flow

- Open your space: use an existing saved space, find owned spaces, or enter a
  handle/custom domain and authenticate to that space.
- Create your space: enter an invite, verify email, choose an available handle,
  finish local account setup, and enter the conversation.
- Reopening resumes a claimed invite and the same installation. An unavailable
  handle or interrupted request must not consume another invite or create a
  second installation.
- Offer the existing computer enrollment flow after authentication. The user's
  first message remains their own; onboarding never inserts or sends prompt text.

The welcome screen owns these two choices. Each subsequent screen asks for the
next necessary input and shows one primary action. Reuse the shared auth layout,
controls, stars, and loading states. Space settings and operator controls belong
in their existing surfaces.

## Service boundaries

Invites are single-use, hashed, revocable, and optionally expiring. Accounts
records issued, claimed, provisioning, and active progress. A verified principal
claims an invite; its creation operation is durable and idempotent. Private
operator policy assigns the invite's plan before activation. The public runtime
does not define commercial tiers or prices.

Entitlements supply versioned, expiring policy snapshots keyed by immutable
installation identity. Metered services retain atomic admission, usage,
cancellation, and settlement. Plan defaults plus explicit space overrides are
resolved by the private policy owner. Existing allowances survive adoption.

## Acceptance

Validate a clean installation and an upgrade: obtain an invite, verify identity,
claim a handle, complete setup, connect a machine, run a useful task, quit and
return. Exercise concurrent redemption, handle races, lost responses, reopening
during setup, revocation, quota exhaustion, override removal, and private/public
composition. Diagnostic events contain stage, outcome, and timing, not codes,
credentials, email addresses, queries, or conversation content.


## Allowance audit

Commercial allowances belong to private Accounts plans and per-space overrides;
services own live admission, durable usage and provider effects. The public SDK
owns snapshot validation and the shared five-minute cache. The Mail adapter's
optional `ENTITLEMENTS` binding consumes that contract. Without it an operator
may supply deployment allowances; with it, policy failure is fail-closed.

| Setting | Owner / treatment |
| --- | --- |
| Managed inference inclusion and monthly spend | Accounts entitlements; Inference reservations |
| Search inclusion and monthly/minute requests | Accounts entitlements; Search atomic admissions |
| Incoming/outgoing mail inclusion, daily messages/bytes, summary attempts | Accounts entitlements; Mail atomic daily reservations |
| Incoming message and outgoing text size allowance | Accounts entitlements, bounded by the mail/Kernel transport ceilings |
| Inference deployment spend ceiling, operational enable switches and model routing | Operator safety controls; retained independently of cached plan values |
| Login/email verification, pending pairing and federation abuse bounds | Authentication/security owners; not purchasable allowances |
| MIME/header nesting, stream/message byte ceilings, protocol buffers | Parser/transport safeguards; retained at the boundary |
| Retry counts, operation deadlines, alarm batches, cache TTL, pagination | Runtime policy and implementation bounds |
| Provider SDK/model limits and inference output defaults | Provider/execution configuration; not subscription plans |
| Storage, connected machines, agents, schedules and retention quotas | No commercial allowance currently enforced; introducing these needs an explicit product contract and accounting owner |

The managed deployment must omit mail allowance variables when it binds
Entitlements. Migration 0021 in the private policy repository preserves the
previous values. Development, composed integration tests and production use the
same service binding. No managed service uses exported telemetry as its counter.
