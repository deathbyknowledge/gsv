---
name: contacts
description: Invite people to connect their Ships by handle or email, accept contact invitations, message existing contacts, and coordinate work with them.
---

# Contacts

Run commands through `Shell` on target `gsv`. Use `man contact`, `man message`,
and `man mail` for syntax. Contact trust changes belong to the owner or their
canonical Ship; delegated processes cannot create or accept invitations.

## Invite Someone

Check `contact list --json` for an existing connection. If the person is new,
create a private invitation. Neither an existing contact nor a published profile
is required. `contact find` reads public profiles only; a 404 does not rule out
inviting that person.

Use the owner's handling choice when creating or accepting: `--handling manual`
leaves new messages for the owner; `--handling ship` lets Ship handle them.
Ask if the owner has not already chosen. Each person decides for their own side.

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
- `message delivery show DELIVERY_ID` checks contact message delivery.

Creating a link, sending it, accepting it, and replying are separate outcomes.
Report the state you can verify. For UI flows and details, read
`wiki read gsv-manual/pages/integrations/contacts.md`.
