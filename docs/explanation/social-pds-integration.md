# Social PDS Integration

This document tracks the work needed to make GSV social through PDS and
ATProto repositories.

The target is not a social feed bolted onto GSV. The target is GSV-to-GSV
coordination: sovereign systems can establish Contact by handle, their agents
can exchange bounded asynchronous messages, and public social records can make
profiles, Contacts, packages, vouches, and local news discoverable. DIDs remain
an internal verification detail that the Kernel resolves from handles.

## Finish Line

A complete first version should support this journey:

1. Alice and Hank each have a GSV user linked to a handle-backed PDS repo.
2. Each GSV publishes a public profile, instance record, user directory, local
   news, and package records for public packages.
3. Alice grants Hank's handle permission to use a narrow set of social
   operations.
4. Hank asks Alice's agent a question while Alice is offline.
5. Hank's GSV signs and sends an asynchronous service-to-service social message.
6. Alice's GSV resolves Hank's handle, verifies the underlying DID and envelope
   signature, checks Alice's local grants, stores the inbound message, creates a
   message status, and opens or reuses a social conversation on Alice's init
   process.
7. Alice's agent can update message status and reply from that conversation by
   sending another `social.message.send` on the same thread.
8. Hank's GSV receives signed status updates and the signed reply
   asynchronously and delivers them into Hank's local social thread.
9. Both users can inspect the thread, messages, and message statuses from their
   own GSV.

## Boundaries

The first implementation is instance-scoped: only the main non-root user
(`uid=1000`) owns the GSV's ATProto identity. Additional local users can use
GSV, but they do not get separate gateway-host DID/handle identities until we
add per-user subdomain or DID PLC support.

PDS and ATProto repos provide identity, discovery, public records, and signed
social state. The GSV Kernel remains the authority boundary.

Remote Contacts must not receive direct access to these syscall domains:

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
accepts social messages, publishes packages, vouches for ATProto records, or
posts local news, but should not reveal device ids, platforms, online state,
target names, file paths, shell capability, local network information, or OS
details.

## Architecture Decisions

- Add a new Kernel syscall domain for social networking. Use `social.*` rather
  than overloading `repo.*`, which already means ripgit repositories.
- Keep the GSV PDS Worker in this repository under `pds/`. It is part of the
  GSV stack, not an external runtime dependency.
- Bind the PDS Worker into Gateway twice by behavior: public `/xrpc/*` traffic
  is forwarded with `fetch`, while internal GSV code uses the PDS Worker
  Entrypoint RPC methods.
- Treat direct signed HTTP envelopes as the interaction transport for the first
  version. PDS records discover endpoints and keys; they are not the only
  message transport.
- Make social messages asynchronous by default. Outbound sends return accepted,
  rejected, or retryable delivery state, not the remote model reply.
- Map social threads to real Process DO conversations:
  `social:<peer-handle>:<thread-id>`.
- Store protocol state in Kernel social tables, and store agent-visible
  conversation state in the Process DO.
- Start with scheduled or manual Contact-record sync. Live firehose ingestion can
  come later.
- Keep Contact grants local to the Kernel. Public Contact records are not
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

If testing an unmerged branch, make sure `gateway/.dev.vars` points bootstrap at
a ref that exists on the upstream you will push:

```bash
GSV_BOOTSTRAP_UPSTREAM=deathbyknowledge/gsv
GSV_BOOTSTRAP_REF=<branch>
```

Complete first-run setup at each local origin:

- Alice: `http://localhost:8787`, handle `gsv-8787.gsv.local`
- Bob: `http://localhost:8788`, handle `gsv-8788.gsv.local`

In `GSV_DEV=1`, handles of the form `gsv-{port}.gsv.local` resolve back to the
matching local server, so no HTTPS tunnel is required for local two-GSV testing.
Use HTTPS tunnels only when testing public/remote behavior.

After both users exist, verify the gateway-hosted PDS surfaces:

```bash
GSV_A_ORIGIN=http://localhost:8787 \
GSV_A_WS_URL=ws://localhost:8787/ws \
GSV_A_USERNAME=alice \
GSV_A_PASSWORD='alice-password' \
GSV_B_ORIGIN=http://localhost:8788 \
GSV_B_WS_URL=ws://localhost:8788/ws \
GSV_B_USERNAME=bob \
GSV_B_PASSWORD='bob-password' \
npm run smoke:social:local
```

This verifies identity, DID documents, public `space.gsv.profile`,
`space.gsv.instance`, local news records, and vouch records, handle-based
Contact/grant setup in both directions, one signed async message
from GSV A to GSV B, B's inbound message status, B's signed status update back
to A, a same-thread reply from B to A using `social.message.send`, and a
temporary denied-sender case. The receiver stores inbound social events in its
Kernel social thread state and delivers them to the receiver's init process
conversation.

## Subagent Handoff Context

The current worktree already contains the PDS Worker, Gateway integration, and
initial social Kernel state. A subagent should start by reading this document,
then inspect these files:

- `shared/protocol/src/syscalls/social.ts`: shared record and syscall contracts.
- `gateway/src/kernel/social.ts`: social storage, setup, Contact/grant logic,
  public record publishing, and signed inbound auth.
- `gateway/src/kernel/social.test.ts`: the highest-signal behavioral examples.
- `gateway/src/pds/client.ts`: Gateway-to-PDS binding and XRPC proxy client.
- `gateway/src/index.ts`: public PDS/XRPC proxy routes and `/social/inbound`.
- `builtin-packages/social/`: builtin UI for Contacts, local grants, social
  threads, messages, message statuses, public packages, vouches, and news.
- `pds/src/worker_entry.rs` and `pds/src/entrypoint.ts`: PDS Worker HTTP and
  Worker Entrypoint surface.
- `scripts/dev-stack.sh`: local multi-worker dev setup.
- `scripts/social-local-smoke.mjs`: current two-GSV smoke coverage.

Hard invariants:

- Handles are user-facing. DIDs are internal verification details resolved by
  the Kernel.
- PDS records are discovery and public state. Kernel tables are the authority
  for grants, local delivery state, and Contact trust.
- Public records must not expose device inventory, local paths, OS details,
  network topology, shell capability, or remote syscall capability.
- Remote GSVs never call `proc.*`, `fs.*`, `shell.exec`, `repo.*`, device,
  token, OAuth, MCP, or config syscalls directly.
- Signed inbound traffic must enter through `social.inbound` and must pass
  handle resolution, DID check, service key check, signature check, recipient
  check, expiry check, replay check, and local grant check before any local side
  effect.
- Social delivery is asynchronous. An outbound send records local delivery
  state and may later be accepted, rejected, retried, delivered, or failed.

Completed milestones:

- `space.gsv.*` protocol record types and PDS lexicons exist.
- GSV onboarding can create the builtin PDS account for the main non-root user.
- Gateway exposes public PDS routes and uses the PDS Worker over service
  binding RPC internally.
- Local social identity/profile/instance/user records can be published.
- Contacts can be added by handle and assigned narrow local grants.
- Signed inbound social envelopes can be accepted or rejected with replay
  protection.
- Social threads and messages are stored in Kernel tables.
- `social.thread.create`, `social.thread.list`, `social.thread.get`,
  `social.message.send`, `social.message.status.list`,
  `social.message.status.get`, and `social.message.status.update` are
  implemented.
- Outbound messages are signed and posted to the remote GSV inbound endpoint,
  with local delivery status updated from the immediate remote response.
- Transient outbound failures are retried by Kernel scheduled callbacks with a
  bounded attempt count; permanent failures are marked `failed`.
- Accepted inbound messages are idempotently stored before process delivery and
  rendered into the main user's init process conversation with an initial
  `received` message status.
- Inbound message status updates are signed, accepted idempotently, and stored
  against the corresponding local message.
- Public packages, vouches, and news can be listed through the social
  command/syscall surface. Public package records are projected when package
  sources are made public.
- The builtin Social app can manage Contacts, edit local grants, inspect
  threads, send messages, update message statuses, inspect the inbox, and view
  public Contact records, packages, package releases, vouches, and news.

Next implementation contract:

- Sync the builtin package into a local GSV and use the Social app against two
  dev-stack instances.
- Add broader Contact public-record sync after the on-demand public-package and
  user-directory reads are verified.
- Extend smoke coverage only where it maps to implemented protocol surfaces,
  especially status transitions, vouch/news discovery, and denied sender
  authorization.

## TODOs

### 1. Define Public GSV Records

- [x] Define initial `space.gsv.*` record contracts in `@gsv/protocol`.
- [x] Publish matching ATProto Lexicon schemas.
- [x] `space.gsv.profile`: display name, avatar, short bio, links.
- [x] `space.gsv.instance`: GSV endpoint, protocol version, service signing key,
      accepted social methods.
- [x] `space.gsv.contact`: public Contact relationships without private grants
      or notes.
- [x] `space.gsv.package`: package/source published by the GSV.
- [x] `space.gsv.package.release`: release metadata for published packages.
- [x] `space.gsv.vouch`: a public vouch for an ATProto record URI.
- [x] `space.gsv.news`: local news items published by the GSV.
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
      `space.gsv.user` records from GSV.
- [x] Add tests for ownership, validation, and update behavior.

### 3. Add Local Contact And Grant State

- [x] Add Kernel tables for known social identities.
- [x] Add Kernel tables for social grants keyed by remote handle.
- [x] Model grants as social operations, not broad trust:
      `social.message.send`, `social.thread.create`,
      `social.message.status.update`, `social.package.read`,
      `social.vouch.read`, `social.news.read`, and similar.
- [x] Add `social.contact.list`, `social.contact.add`,
      `social.contact.remove`,
      and grant update syscalls.
- [x] Ensure public Contact records never grant authority by themselves.
- [ ] Add authorization tests for allowed, denied, revoked, expired, and unknown
      remote handles.

### 4. Implement Service-To-Service Auth

- [x] Define signed social envelopes with id, method, internal sender
      DID, internal recipient DID, created time, expiry, nonce, body, key id,
      and signature.
- [x] Resolve the sender handle and verify its DID and advertised GSV service
      key.
- [x] Reject expired envelopes.
- [x] Reject replayed ids or nonces.
- [x] Reject envelopes whose internal recipient DID does not match the local
      user.
- [x] Route verified inbound envelopes through a service-only
      `social.inbound` syscall.
- [x] Add negative tests for bad signature, wrong DID, wrong key, replay,
      expiry, missing grant, and malformed body.

### 5. Add Social Threads, Messages, And Statuses

- [x] Add Kernel tables for social threads, messages, message statuses,
      delivery attempts, and remote event ids.
- [x] Define shared protocol types for social threads, messages, delivery
      status, and message status.
- [x] Add `social.thread.create`, `social.thread.list`, `social.thread.get`,
      `social.message.send`, `social.message.status.list`,
      `social.message.status.get`, and `social.message.status.update`.
- [x] Make outbound sends asynchronous with local status:
      `queued`, `sent`, `accepted`, `failed`, `retrying`, `delivered`.
- [x] Add bounded retries for transient remote failures.
- [x] Add idempotency for duplicate inbound message ids.
- [x] Add idempotency for duplicate inbound message status update ids.
- [x] Enforce max message size and allowed content types.
- [x] Add tests for thread creation, follow-up routing, retry scheduling,
      idempotency, and status transitions.

### 6. Deliver Social Events To Processes

- [x] Add a Kernel-owned process event delivery path for typed social events.
- [x] Open or reuse `conversationId =
      social:<peer-handle>:<thread-id>` on the user's init process.
- [x] Render inbound social messages as explicit process events, preserving
      peer handle, thread id, message id, and message status metadata.
- [x] Add an agent-visible way to reply through `social.message.send` with the
      existing `threadId`.
- [x] Do not expose remote peers as callers of `proc.send`.
- [x] Add tests proving inbound social messages create or reuse the expected
      Process DO conversation.

### 7. Add Social Message Status And Inbox State

- [x] Add `social.message.status.list`, `social.message.status.get`, and
      `social.message.status.update`.
- [x] Track message status:
      `received`, `triaged`, `in_progress`, `needs_human`, `completed`,
      `declined`, `failed`.
- [x] Integrate notifications for inbound messages that need user attention.
- [x] Maintain a generated inbox index at `~/context.d/90-social-inbox.md` when
      there are active inbound message statuses.
- [x] Keep the context file as an index only; Kernel tables remain the source of
      truth.
- [x] Add tests for inbound message storage, status notifications, status
      delivery, and context index generation.
- [ ] Add focused tests for status filtering, status removal from the inbox, and
      explicit thread expiry transitions.

### 8. Sync Contact Public Records

- [x] Fetch and cache Contact `space.gsv.user` records on demand through
      `social.user.list`.
- [x] Fetch and cache Contact `space.gsv.contact`, `space.gsv.package`,
      `space.gsv.package.release`, `space.gsv.vouch`, and `space.gsv.news`
      records on demand through the matching social list syscalls.
- [ ] Store per-Contact repo cursors or latest revisions.
- [ ] Add a general sync handler to poll known Contacts' public PDS
      records.
- [ ] Cache refreshed profile, instance, user, contact, package, vouch, and news
      records beyond Contact add and on-demand list flows.
- [ ] Emit internal signals such as `social.contact.updated` and
      `social.news.created`.
- [ ] Start with scheduled polling or manual sync; do not depend on live
      outgoing WebSocket firehose connections from Durable Objects.
- [ ] Add tests for updated, deleted, malformed, and stale records.

### 9. Surface Public Packages And Signals

- [x] Publish `space.gsv.package` records when package sources are made public.
- [x] List Contact packages, package releases, vouches, and news.
- [x] Show Contact public records in the Social app and social command surface
      when the Contact advertises and is granted the matching read operation.
- [ ] Connect public packages to existing package flows:
      `pkg.public.list`, `pkg.add`, `pkg.review.approve`, and `pkg.install`.
- [x] Add tests for local publish/list/delete and remote public-record reads.
- [ ] Add tests for package install/review handoff once that flow exists.

### 10. Build End-To-End Smoke Tests

- [x] Add a two-GSV test harness or smoke script.
- [x] Create two users with linked handles.
- [x] Publish vouch and news records.
- [x] Publish profile and instance records.
- [x] Add current Contact grants in both directions.
- [x] Send a signed async message from Hank to Alice.
- [x] Verify Alice stores the social conversation and inbound message status.
- [x] Update Alice's inbound message status and verify Hank receives the status.
- [x] Reply from Alice back to Hank with `social.message.send` on the original
      thread.
- [x] Verify Hank receives the reply and reply status in the original thread.
- [x] Verify denied handles cannot send messages.
- [ ] Verify no public record contains device inventory.

## Deferred

- Human browser login with a Contact's GSV identity.
- Shared workspace collaboration beyond curated summaries and social messages.
- Private context capsules.
- Live firehose ingestion.
- Remote device exposure.
- Direct remote access to local process, filesystem, shell, ripgit, MCP, token,
  OAuth, or device syscalls.
