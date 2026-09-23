# Invite people

A space can hold more than one person. The root account invites people, sets or resets their passwords, and removes their access. Everyone else sees only their own account.

## Invite a person

1. Sign in as **root** and open **Settings → people.**
2. Under **Invite a person**, enter the username they will use: lowercase, starting with a letter or `_`, up to 32 characters.
3. Click **create invitation.** GSV shows a private link; **copy link** and send it over a channel you trust.

The link expires after ten minutes. The person opens it, chooses their password, and is signed in to their own account in your space. Pending invitations are listed under **Invitations**, each with **cancel invitation**.

## Manage accounts

**Accounts** lists everyone in the space, marking root and removed accounts. For each other person:

- **set password** sets a new password (at least 8 characters). Their existing credentials and messenger links are revoked, so they sign in again and re-link any messengers.
- **remove access** stops their credentials and messenger links from working. Their data and any work already running remain in the space.

## What a person can do

Each account has its own conversations, processes and files, and its own approval policy under **Settings → permissions**. Capability grants set the outer limit of what an account may do; see the [security model](/architecture/security-model). An account cannot see another account's people or sign-in settings.

## See also

- [Run GSV for your organisation](/how-to/organisations) — when you need spaces for a whole team
- [Configuration reference](/reference/configuration) — the keys behind per-account settings
