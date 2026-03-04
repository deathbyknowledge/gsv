# GSV Design TODOS

## Thread-Centric Rollout

### Done

- [x] Spec rewrite to thread-centric architecture (`threadId` logical identity, `stateId` execution identity).
- [x] `RegistryStore` abstraction and route/meta registries in Gateway DO storage.
- [x] Inbound router resolves `(spaceId, agentId, threadId, stateId)` with membership checks.
- [x] Legacy no-fork compatibility path (`legacySession:*` + exact legacy DO identity execution).
- [x] Capability-based dispatch guards (`deny > allow`, default deny).
- [x] Principal onboarding states and pending binding flow (`unpaired`, `allowed_unbound`, `bound`).
- [x] Registry management RPCs + CLI commands (`principal`, `member`, `conversation`, `pending`).
- [x] RPC session/chat targeting with `sessionKey | threadRef` (`id:` supported).
- [x] Gateway chat events and RPC responses include `threadId`/`stateId`.
- [x] CLI support for `--thread-ref` on client/session commands.
- [x] React UI surfaces thread id in chat header and sessions table.
- [x] React UI chat/session RPC calls use `threadRef=id:{threadId}` when available.
- [x] `gsv__SessionSend` now accepts `sessionKey` or `threadRef` (id form).
- [x] `gsv__SessionsList` returns `threadId`/`stateId` and previews via resolved `stateId` when present.
- [x] Cron execution resolves target via session/thread resolver (uses resolved `stateId` DO identity).
- [x] Pending tool callbacks and async-exec delivery now resolve/use Session DO identity (`sessionDoName`) instead of assuming raw `sessionKey`.
- [x] Channel last-active context stores a DO-routable session target for heartbeat/session-busy checks.
- [x] Invite lifecycle backend implemented (`invite.create|list|revoke|claim`) with registry persistence.
- [x] Self-registration path for unbound principals via channel command (`/claim <invite_code>`).
- [x] CLI invite management commands (`registry invite list|create|revoke|claim`).
- [x] React UI invite lifecycle controls added in Pairing tab (create/list/revoke/claim + refresh).
- [x] Cross-space guards for session-native cross-session tools:
  - `gsv__SessionSend` now blocks cross-space targets unless caller principal is owner.
  - `gsv__SessionsList` now scopes to caller space for non-owner callers.

### Next

- [x] Add migration/backfill + registry repair tooling for existing deployments.
- [x] Expand integration/e2e coverage:
  - no-fork upgrade path
  - group mode behavior (`group-shared`, `per-user-in-group`)
  - onboarding policy matrix (`manual`, `invite`, `auto-guest`, `auto-bind-default`)
