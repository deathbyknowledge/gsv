# Social PDS Integration

This document tracks the work needed to make GSV social through PDS and
ATProto repositories.

The target is not a social feed bolted onto GSV. The target is GSV-to-GSV
coordination: people can friend each other by handle, their agents can exchange
bounded asynchronous messages, and public social records can make packages,
profiles, and agent contact cards discoverable. DIDs remain an internal
verification detail that the Kernel resolves from handles.

## Finish Line

A complete first version should support this journey:

1. Alice and Hank each have a GSV user linked to a handle-backed PDS repo.
2. Each GSV publishes a public profile, instance contact record, agent card, and
   package-like records.
3. Alice grants Hank's handle permission to use a narrow set of social
   operations.
4. Hank asks Alice's agent a question while Alice is offline.
5. Hank's GSV signs and sends an asynchronous service-to-service social message.
6. Alice's GSV resolves Hank's handle, verifies the underlying DID and request
   signature, checks Alice's local grants, stores the inbound message, and opens
   or reuses a social conversation on Alice's init process.
7. Alice's agent can reply from that conversation using a social reply syscall.
8. Hank's GSV receives the signed reply asynchronously and delivers it into
   Hank's local social thread.
9. Both users can inspect the thread, its status, and any request state from
   their own GSV.

## Boundaries

The first implementation is instance-scoped: only the main non-root user
(`uid=1000`) owns the GSV's ATProto identity. Additional local users can use
GSV, but they do not get separate gateway-host DID/handle identities until we
add per-user subdomain or DID PLC support.

PDS and ATProto repos provide identity, discovery, public records, and signed
social state. The GSV Kernel remains the authority boundary.

Remote friends must not receive direct access to these syscall domains:

- `fs.*`
- `shell.exec`
- `repo.*`
- `proc.*`
- `sys.device.*`
- `sys.config.*`
- `sys.token.*`
- `sys.oauth.*`
- `sys.mcp.*`

Remote interaction should enter through a dedicated social syscall surface.
That surface may deliver local process events after Kernel authorization, but a
remote GSV should never call process, filesystem, shell, device, or ripgit
syscalls directly.

Do not publish device inventory by default. Public records may say that the GSV
accepts social messages or package likes, but should not reveal device ids,
platforms, online state, target names, file paths, shell capability, local
network information, or OS details.

## Architecture Decisions

- Add a new Kernel syscall domain for social networking. Use `social.*` rather
  than overloading `repo.*`, which already means ripgit repositories.
- Bind the PDS Worker into Gateway twice by behavior: public `/xrpc/*` traffic
  is forwarded with `fetch`, while internal GSV code uses the PDS Worker
  Entrypoint RPC methods.
- Treat direct signed HTTP requests as the interaction transport for the first
  version. PDS records discover endpoints and keys; they are not the only
  message transport.
- Make social messages asynchronous by default. Outbound sends return accepted,
  rejected, or retryable delivery state, not the remote model reply.
- Map social threads to real Process DO conversations:
  `social:<peer-handle>:<thread-id>`.
- Store protocol state in Kernel social tables, and store agent-visible
  conversation state in the Process DO.
- Start with scheduled or manual friend-record sync. Live firehose ingestion can
  come later.
- Keep friend grants local to the Kernel. Public follow records are not
  authority.

## Local Two-GSV Smoke

Run two isolated local dev stacks with separate Durable Object state:

```bash
GSV_DEV_PORT=8787 \
GSV_DEV_PERSIST_TO="$PWD/.wrangler/dev-state-alice" \
npm run dev
```

```bash
GSV_DEV_PORT=8788 \
GSV_DEV_PERSIST_TO="$PWD/.wrangler/dev-state-bob" \
npm run dev
```

Expose each local server through an HTTPS tunnel, then complete first-run setup
for each tunnel URL. The web onboarding will include builtin social setup for
HTTPS origins.

After both users exist, verify the gateway-hosted PDS surfaces:

```bash
GSV_A_ORIGIN=https://alice-tunnel.example \
GSV_A_WS_URL=ws://localhost:8787/ws \
GSV_A_USERNAME=alice \
GSV_A_PASSWORD='alice-password' \
GSV_B_ORIGIN=https://bob-tunnel.example \
GSV_B_WS_URL=ws://localhost:8788/ws \
GSV_B_USERNAME=bob \
GSV_B_PASSWORD='bob-password' \
npm run smoke:social:local
```

This verifies identity, DID documents, public `space.gsv.profile`,
`space.gsv.instance`, and `space.gsv.agent.card` records, and handle-based
friend/grant setup in both directions. Signed inbound service-to-service
authentication is implemented; social thread/message persistence is the next
implementation layer.

## TODOs

### 1. Define Public GSV Records

- [x] Define initial `space.gsv.*` record contracts in `@gsv/protocol`.
- [x] Publish matching ATProto Lexicon schemas.
- [x] `space.gsv.profile`: display name, avatar, short bio, links.
- [x] `space.gsv.instance`: GSV endpoint, protocol version, service signing key,
      accepted social methods.
- [x] `space.gsv.agent.card`: what the user's public or friend-visible agent can
      help with.
- [x] `space.gsv.package.like`: package/source liked by the user.
- [x] Optional `space.gsv.status`: short current activity or collaboration status.
- [x] Explicitly exclude device inventory from public schemas.
- [x] Add fixtures for valid and invalid records.

### 2. Link GSV Users To PDS Identities

- [x] Add Kernel storage for a user's internal DID, handle, and PDS endpoint.
- [x] Add Kernel storage for local social settings.
- [x] Add Gateway-to-PDS service binding scaffolding with public XRPC proxy and
      internal RPC client.
- [x] Add setup/linking flow for creating or attaching a PDS identity.
- [x] Limit the gateway-host social identity to the main non-root user.
- [x] Add syscalls to read and update the local user's public social profile.
- [x] Publish or update `space.gsv.profile`, `space.gsv.instance`, and
      `space.gsv.agent.card` records from GSV.
- [x] Add tests for ownership, validation, and update behavior.

### 3. Add Local Friend And Grant State

- [x] Add Kernel tables for known social identities.
- [x] Add Kernel tables for social grants keyed by remote handle.
- [x] Model grants as social operations, not broad trust:
      `social.message.send`, `social.thread.create`,
      `social.request.create`, `social.package.like.read`, and similar.
- [x] Add `social.friend.list`, `social.friend.add`, `social.friend.remove`,
      and grant update syscalls.
- [x] Ensure public follow/friend records never grant authority by themselves.
- [ ] Add authorization tests for allowed, denied, revoked, expired, and unknown
      remote handles.

### 4. Implement Service-To-Service Auth

- [x] Define signed social request envelopes with id, method, internal sender
      DID, internal recipient DID, created time, expiry, nonce, body, key id,
      and signature.
- [x] Resolve the sender handle and verify its DID and advertised GSV service
      key.
- [x] Reject expired requests.
- [x] Reject replayed ids or nonces.
- [x] Reject requests whose internal recipient DID does not match the local
      user.
- [x] Route verified inbound requests through a service-only
      `social.inbound` syscall.
- [x] Add negative tests for bad signature, wrong DID, wrong key, replay,
      expiry, missing grant, and malformed body.

### 5. Add Social Threads And Messages

- [ ] Add Kernel tables for social threads, messages, delivery attempts, and
      remote event ids.
- [x] Define shared protocol types for social threads, messages, delivery
      status, and request status.
- [ ] Add `social.thread.create`, `social.thread.list`, `social.thread.get`,
      `social.message.send`, and `social.message.reply`.
- [ ] Make outbound sends asynchronous with local status:
      `queued`, `sent`, `accepted`, `failed`, `retrying`, `delivered`.
- [ ] Add bounded retries for transient remote failures.
- [ ] Add idempotency for duplicate inbound message ids.
- [ ] Enforce max message size and allowed content types.
- [ ] Add tests for thread creation, follow-up routing, retries, idempotency,
      and status transitions.

### 6. Deliver Social Events To Processes

- [ ] Add a Kernel-owned process event delivery path for typed social events.
- [ ] Open or reuse `conversationId =
      social:<peer-handle>:<thread-id>` on the user's init process.
- [ ] Render inbound social messages as explicit process events, preserving
      peer handle, thread id, message id, and request metadata.
- [ ] Add an agent-visible way to reply through `social.message.reply`.
- [ ] Do not expose remote peers as callers of `proc.send`.
- [ ] Add tests proving inbound social messages create or reuse the expected
      Process DO conversation.

### 7. Add Social Requests And Inbox State

- [ ] Add `social.request.create`, `social.request.list`,
      `social.request.get`, and `social.request.respond`.
- [ ] Track request status:
      `pending`, `agent-replied`, `needs-human`, `accepted`, `declined`,
      `completed`, `expired`.
- [ ] Integrate `notification.create` for requests that need user attention.
- [ ] Maintain a generated inbox index at `~/context.d/90-social-inbox.md` when
      there are active requests.
- [ ] Keep the context file as an index only; Kernel tables remain the source of
      truth.
- [ ] Add tests for agent-handled requests, needs-human requests, expiry, and
      context index generation/removal.

### 8. Sync Friend Public Records

- [ ] Store per-friend repo cursors or latest revisions.
- [ ] Add `social.sync.run` to poll known friends' public PDS records.
- [ ] Cache public profile, instance, agent-card, package-like, and status
      records.
- [ ] Emit internal signals such as `social.friend.updated` and
      `social.package.like.created`.
- [ ] Start with scheduled polling or manual sync; do not depend on live
      outgoing WebSocket firehose connections from Durable Objects.
- [ ] Add tests for updated, deleted, malformed, and stale records.

### 9. Surface Package Likes

- [ ] Publish local package likes as `space.gsv.package.like` records.
- [ ] Show friend package likes in the package UI or package CLI.
- [ ] Connect liked packages to existing package flows:
      `pkg.public.list`, `pkg.add`, `pkg.review.approve`, and `pkg.install`.
- [ ] Add tests for visibility, package identity normalization, and install
      handoff.

### 10. Build End-To-End Smoke Tests

- [ ] Add a two-GSV test harness or smoke script.
- [ ] Create two users with linked handles.
- [ ] Publish profile, instance, agent-card, and package-like records.
- [ ] Add a friend grant from Alice to Hank.
- [ ] Send a signed async message from Hank to Alice.
- [ ] Verify Alice's init process receives the social conversation.
- [ ] Reply from Alice back to Hank.
- [ ] Verify Hank receives the reply in the original thread.
- [ ] Verify denied handles cannot send messages.
- [ ] Verify no public record contains device inventory.

## Deferred

- Human browser login with a friend's GSV identity.
- Shared workspace collaboration beyond curated summaries and social requests.
- Private context capsules.
- Live firehose ingestion.
- Remote device exposure.
- Direct remote access to local process, filesystem, shell, ripgit, MCP, token,
  OAuth, or device syscalls.
