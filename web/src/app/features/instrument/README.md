# Instrument surfaces

Zen owns the conversation. A fresh conversation shows the first-day introduction inline, with shortcuts to the ordinary connection controls. Helpers have a simple empty conversation state. There is no first-day navigation destination; existing `/first-day` links open Zen.

Fleet owns places, contacts, processes, activity, and their inspectors. Places always offers Connect, and Contacts always offers Add contact, subject to the signed-in account's permissions. A new place can be a computer or browser. A contact is another Ship and has its own list and inspector, separate from execution targets. Opening a connection form never creates a credential or invitation.

The place flow creates an explicit pairing key and provides install/connection instructions for the active gateway. Cancelling revokes the displayed key; a key returned after an undisplayed operation has been closed is also revoked. Connected places remain visible while adding another, and existing device IDs are not reused for new places.

Contacts supports creating and accepting invitations, pending invitation cancellation, aliases, and revocation. The contact list loads when Fleet opens and has an explicit refresh control. Only an invitation currently being watched is polled; its acceptance refreshes the contact list before displaying completion. Closing the form ends that watch.

Settings owns model order and creation, permissions, instructions, and integrations. See [Settings](settings/README.md). The initial Zen suggestions navigate to Fleet and Settings instead of maintaining separate setup flows.
