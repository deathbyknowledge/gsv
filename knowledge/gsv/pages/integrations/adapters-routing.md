# Message Adapters & Routing

[Integrations](index.md)

Message adapters connect GSV to external chat or messaging platforms. An adapter account represents the connection to the platform. An external identity link maps a sender on that platform to a GSV user.

## Supported Adapter Concepts

- WhatsApp and Discord are normal message adapter examples.
- Telegram-style or test adapters may be used for development, testing, or controlled routing.
- Each adapter owns platform-specific login, account state, inbound events, and outbound delivery.

## Connecting An Adapter

Use the GSV console integration area to connect, inspect, or disconnect adapter accounts. A connected adapter may still need individual external senders to link themselves to GSV users.

## Identity Links

An identity link answers: "When this outside person messages GSV, which GSV user do they represent?"

Unlinked direct-message senders may receive a link challenge. Unlinked group or channel senders may be ignored depending on adapter behavior and policy.

## Message Routing

Inbound messages are normalized by the adapter, then routed into GSV. Routing may decide:

- Which GSV user owns the message.
- Which agent or conversation receives it.
- Whether media should be attached.
- Whether the response should go back to the same external surface.
- Whether the action requires approval.

## For Agents

Do not assume that an external display name is a trusted GSV identity. Use the established link and account information. When replying externally, make clear if the response will leave GSV.
