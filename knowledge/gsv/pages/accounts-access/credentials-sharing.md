# Credentials, Sessions & Sharing Boundaries

[Accounts & Access](index.md)

## Credentials And Tokens

Credentials prove that a person, device, service, or integration is allowed to connect. Tokens are sensitive. Treat them like passwords.

Use the GSV console or approved system surfaces to:

- Create tokens.
- Review active tokens.
- Revoke tokens.
- Connect devices.
- Connect integrations.
- Recover from suspicious access.

Raw token values may only be shown once when created. Store them in the appropriate secret manager or device configuration, not in ordinary notes or chat.

## Sessions

A session is an active login or connection. If a browser or device is lost, revoke the relevant session or token. If a user signs in from a new browser, that browser may get its own session.

## External Identity Links

External identity links connect a person on a platform such as WhatsApp or Discord to a GSV account. The link decides which GSV user receives inbound messages and which account owns replies.

Linking an external identity is not the same as connecting the adapter account itself. An adapter can be connected while a specific external sender is still unlinked.

## Sharing Boundaries

Sharing should be explicit. Before granting access, decide:

- Which account or group needs access.
- Whether access is read-only or can change state.
- Whether the access is temporary.
- Whether the access includes files, knowledge, packages, integrations, or settings.

## For Agents

Do not print secrets into chat or Wiki. If a workflow needs a secret, use the correct credential or settings surface and report only that it was configured or that configuration is still needed.
