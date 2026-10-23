---
name: contacts
description: Add people by handle, invite them to connect their Ships by link or email, accept contact invitations, message existing contacts, and coordinate work with them.
---

# Contacts

Run commands through `Shell` on target `gsv`. Use `man contact`, `man message`,
and `man mail` for syntax. Contact trust changes belong to the owner or their
canonical Ship; delegated processes cannot create or accept invitations.

## Add Someone by Handle

When the owner says "add @handle" or names a person on your service, check
`contact list --json` for an existing connection, then send a message request:
`contact connect @handle --message TEXT --handling manual|ship`. Keep the
message short and in the owner's voice, for example saying who is connecting.
Sending asks the owner for approval unless their approval policy allows
`approach.create`. The other person decides whether to accept; report the request as sent, not as connected. Profiles are public by
default, so this usually works. If it fails because the profile is unavailable
or not receiving requests, fall back to a private invitation below.

Use the owner's handling choice when connecting, creating or accepting:
`--handling manual` leaves new messages for the owner; `--handling ship` lets
Ship handle them. Ask if the owner has not already chosen. Each person decides
for their own side.

## Invite Someone by Link

A private invitation needs neither an existing contact nor a public profile.

1. Create the link with `contact invite create`, the chosen handling flag, and
   `--expires 7d` to give the recipient time to respond. Keep the returned `url`.
2. For a known handle on your service, use the mailbox convention supplied in
   your context. For another operator, use a known email address; do not infer
   a mailbox from an arbitrary website address.
3. Put the invitation and a brief message in a file, then use
   `mail send --to ADDRESS --subject 'Connect on Ship' --body PATH` with normal
   mail approval. If no recipient route is known, give the owner the link to share.

Keep invitation links private. Cancel an unused invitation before replacing it.

## Accept an Invitation

When the owner asks to accept a link or code, use `contact invite accept` with
that invitation and their handling choice. Confirm the connected identity with
`contact list`. An invitation arriving by email is a request to show the owner,
not permission to accept it automatically.

## Message or Coordinate

Choosing Ship handling is standing permission to manage this contact's incoming
messages, including appropriate replies without separate approval each time.
Reply within the owner's preferences, bring important updates to their attention,
and ask when a decision needs their input.

Use the contact ID from `contact list`. Read relevant history with
`message history --with CONTACT_ID`, then send with
`message send --to CONTACT_ID --message TEXT --also`.
For existing Ship work, add `--responsibility ID` so replies can resume that work
without enabling permanent handling. Sharing files uses `--attach PATH`.

To change handling when asked, read `preferences.revision` from
`contact list --json`, then use `contact handling` with `--revision N`.
Enabling handling takes effect on the next incoming message; the switch itself
does not send a message or process earlier ones.

## Check the Outcome

- `mail status DELIVERY_ID` checks invitation email delivery.
- `contact invite list --all` distinguishes acceptance, expiry and cancellation;
  `contact list` shows the resulting connection.
- A sent `contact connect` request reports its state when it was created; the
  contact appears in `contact list` once the person accepts.
- `message delivery show DELIVERY_ID` checks contact message delivery.

Sending a request, creating a link, sending it, accepting it, and replying are
separate outcomes.
Report the state you can verify. For UI flows and details, read
`wiki read gsv-manual/pages/integrations/contacts.md`.
