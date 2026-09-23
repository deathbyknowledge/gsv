# Invite onboarding

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
