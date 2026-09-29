# Contact people on other GSVs

Contacts connect people across spaces. Use a private contact invitation to connect, then open the contact in **Fleet** to read its conversation or manage requests. Contact invitations are separate from [inviting an account into your space](/how-to/invite-people).

## Requests

The person offering work can cancel an unaccepted offer. The person receiving it can accept or reject it, then start, complete or cancel accepted work. GSV shows only the actions available to your side.

An update takes effect locally before the other GSV confirms it. **Awaiting confirmation** keeps the request open, including a completion or cancellation. **Update not confirmed** means delivery failed; it does not claim the other person accepted that outcome. Older records can show **Confirmation unavailable**.

## Delivery

Queued messages retry automatically with the same identity. A recoverable failure can be resumed through `contact.delivery.retry` by the signed-in person or their Ship. Retrying resends the stored message; it does not add another message to the conversation. Permanent refusals, revoked contacts and messages older than seven days cannot be retried.

See the [contact commands](/reference/cli-commands) and [contact syscalls](/reference/syscalls) for delivery inspection and automation.
