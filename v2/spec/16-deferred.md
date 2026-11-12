# 16 · Deferred

What 2.0 deliberately leaves out. Each line says why and what 2.0 keeps so the
later work fits without a redesign. Nothing here is built in the spike.

## Customer-facing business

Postponed past 2.0: personal Ship comes first, and business isn't proven yet
`[D 11-12]`. The design stays on record:

- The Business profile and its front agent (a role that routes outsiders and
  may do short work).
- One conversation per outside sender, open to everyone.
- Chat from the public page at the handle.
- The vouched-sender widening: a signed-in Ship can vouch for its person.
- Staff taking over a conversation, and limits on outsiders.
- WhatsApp for businesses: we would have to become a Meta Tech Provider, and
  Meta bills per conversation.

What 2.0 keeps because personal Ship or self-hosting needs it: own bot-token
messenger connections, bindings, groups and contacts `[D 11-12]`.

## Company-internal use

Later release, on teams as decided `[D 11-12]`:

- Company OIDC sign-in.
- Team features beyond the built-in members team and the two-owner rule.
- A UI for team agents.
- A separate OS user per member on team machines. In 2.0 a team machine runs
  every command as one OS user, so members' agents can read each other's files
  there `[D 11-11]`.

Cross-space teams were dropped. Teams stay inside one space and sign-in stays
checked in the Space DO `[D 11-12]`.

## App layer

No app layer in 2.0: Ship is the release's person profile `[D 11-12]`.
Installable apps and local apps (a folder holding a manifest and optional
code, installed for one owner) are out. The local-app format is kept for 2.1
`[D 11-12]`. The developer surface (profile, config and SDK) stays private
until it is proven `[D 11-12]`.

## Identity across deployments

- No DID or ATProto in 2.0. Owner ids are opaque and never reused, the
  deployment sets the sender, and company names come from one domain check
  `[D 11-11]`.
- No Bluesky profile copy. 1.0's copy stays until the migration `[D 11-11]`.
- No Ship-to-Ship messages between deployments. Ships reach each other inside
  one deployment as events from one owner to another, and by email in the
  meantime `[D 11-11]`.

## Machines

- Command confinement on machines is deferred to 2.1. In 2.0, `confine`
  limits are set by the Target DO and only applied by gsvd `[D 11-11]`.
- The rule that approvals during a screen session need Touch ID or a passkey
  was never decided and is not in 2.0 `[D 11-11]`.

## Mail

No custom mail domains for now: nobody has asked yet, and each domain needs
Cloudflare Enterprise or a mail provider `[D 11-11]`.

## Security

No new security features for now. Revisit them when a customer asks
`[D 11-09]`:

- tamper-evident history;
- one key per owner, so offboarding or deletion destroys the data by deleting
  the key;
- keys held by the customer.

The author uid and pid stay on each revision `[D 11-09]`.

## Platform

- workerd cluster mode: watched, not promised. celld is not a 2.0 target
  `[D 11-11]`.
- Protobuf, only if clients not written in TypeScript multiply `[D 11-11]`.
- One-shot HTTP calls, added when a real caller needs them `[D 11-11]`.
- Embeddings, only if search misses paraphrases, measured first `[D 11-09]`.
- OS push notifications. 2.0 has a ping (tab or window attention, a sound),
  and OS notifications come later `[D 11-12]`.

## Migration from 1.0

Parked until 2.0 is built `[D 11-11]`. The shape proposed on 2026-11-09 is on
record: one space at a time, keeping the same installation id so handles, mail
addresses and messenger links survive. History is converted once into records.
