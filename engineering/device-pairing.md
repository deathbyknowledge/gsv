# Device invitations

Pairing a computer or browser should require one invitation, rather than manually
copying a gateway URL, username, target ID and credential. The signed-in human
names the place first. Its ID starts from that label (`My macbook` → `my-macbook`),
follows edits until customized, and stays stable once the invitation is issued.
The operating system only changes installation instructions.

The Kernel owns a ten-minute, single-use invitation scoped to its installation,
issuing human and target. It stores the invitation secret hashed. Creation uses a
client-persisted request identity and secret so a lost response can be retried.
Closing the UI leaves the invitation resumable in that browser session; explicit
cancellation invalidates an unused invitation. Neither operation revokes a
credential that a device has already acquired.

The code carries the gateway address, account, target label/ID and invitation
authorization. `gsv pair CODE` and the extension's paste field use the same
pre-authentication redemption syscall. This syscall cannot choose an account,
target or principal kind: the invitation fixes them. It is admitted only through
the ordinary installation routing and managed-work gate.

The receiving client persists a fresh random device credential before redemption.
The Kernel atomically consumes the invitation and stores that credential's hash
as a machine token bound to the target ID. Repeating the same redemption can
recover its acknowledgment; another credential cannot redeem the invitation.
The code is never an ordinary connection credential, and redeeming it grants no
human session. The device credential remains valid until explicitly revoked.

Invitation codes, secrets and credentials never enter URLs, logs, diagnostics or
ledger arguments. The UI retains only its expiring invitation; the receiving
client retains its own credential in its existing private configuration store.
Failed local service installation can be retried without issuing another token.

The browser saves its creation identity before dispatch. A definitive creation
refusal clears that attempt and unlocks the name/ID fields; an uncertain network
failure retains it for retry. Receivers similarly retain an uncertain exchange
and clear terminally expired, cancelled, unavailable or already-used invitations.
The Kernel retains redemption receipts for thirty days after invitation expiry.
Explicit pair-again invitations require an existing target owned by the issuer;
forgetting a place cancels its pending invitations as well as revoking its keys.

The gateway, web, CLI and browser extension must ship together for this flow.
Existing machine credentials and manual configuration remain supported.
