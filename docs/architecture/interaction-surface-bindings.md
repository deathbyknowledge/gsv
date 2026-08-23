# Surface Bindings and Output Graphs (Deferred)

Status: **superseded proposal**. The original universal-routing-graph design
predated GSV's canonical Conversation model and treated a Process as the durable
conversation. That premise is no longer valid. Git history retains the detailed
proposal; this page records only the constraints on any future replacement.

The current architecture is described in
[Conversations and Process Activity](./conversations.md):

- A Conversation owns canonical user-visible Messages and survives Process
  replacement or deletion.
- A Process owns raw execution activity and handles a Conversation interaction.
- An exact run route identifies the endpoint that admitted one interaction. It
  controls directed streaming and immediate delivery, not message ownership.
- `proc.observe` is a connection-scoped view of raw Process activity, not a
  conversation binding.
- Private adapter DMs default to Home and may temporarily select Work. Shared
  adapter surfaces retain their existing Kernel-owned route semantics.

There is no public `route.*` graph, durable output-edge schema, generic sink
registry, or client inbox. Do not implement one by reviving the old proposal's
Process-owned conversation or automatic-output assumptions.

## Possible future work

A future product may still need durable policies such as:

- binding a named surface to a Conversation rather than directly to a PID;
- adding an authorized Process as a Conversation handler or observer;
- forwarding an explicitly committed Message to another Conversation; or
- binding a durable offline delivery policy to an endpoint without turning its
  live peer session into message storage.

Those features must extend the current primitives instead of creating a second
message model. In particular:

- Canonical Messages remain in Conversation storage.
- The Kernel derives user and installation identity and owns authorization.
- Binding changes affect future admission and never move an already admitted run.
- A Message or route identifier is not authority.
- Process-to-Process IPC remains explicit and does not create a user Message or
  reverse route unless the handling Process deliberately chooses one.
- Provider identifiers stay inside the Kernel and adapter boundary.
- Revisions and delivery identities must fence stale or replayed work.
- Raw reasoning, tool activity, and lifecycle signals never become canonical
  Messages merely because a route exists.

Any concrete graph design should begin from Conversation membership, directed
endpoint delivery, and the shared protocol-peer model—not from the removed
automatic Process-output graph.

## See also

- [Conversations and Process Activity](./conversations.md)
- [Unified Protocol Peers](./unified-protocol-peers.md)
- [The Adapter Model](./adapter-model.md)
