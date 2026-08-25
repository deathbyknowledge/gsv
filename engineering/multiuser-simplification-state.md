# Multiuser simplification — current state

> This is the current implementation and cutoff contract. The older
> `multiuser-simplification-plan.md` is an execution artifact; this file
> supersedes it where the implementation evolved.

## Final architecture

- The existing Kernel Durable Object named `singleton` remains the ship's
  Master Control Program. It retains its SQLite data and remains the only
  authority for accounts, immutable canonical usernames, uid/gid allocation,
  credentials, groups, capabilities, configuration, packages, repository
  metadata, adapter accounts and links, placement, commissioning, and future
  admission policy.
- Each login-capable human has one runtime Kernel named
  `user:<canonical-username>`. The canonical username is the public ship-local
  identity and direct routing key; there is no second principal id or alias
  lookup in front of it.
- An active user Kernel owns fresh local connections, devices, process and
  conversation registries, routes, schedules, app sessions, OAuth/MCP state,
  and other runtime coordination. Process and AppRunner Durable Objects keep
  execution and package-data ownership at their existing object names.
- User Kernels contain no durable copy of Master authority. They resolve current
  account, capability, configuration, package, repository, and link decisions
  through narrow typed Master RPCs and master-owned syscalls.
- `/ws` is commissioning-only. Normal humans, devices, and services use
  `/ws/<canonical-username>`. Unknown accounts fail closed; a known
  `provisioning` placement may be completed only by the Master-owned ensure
  operation, and normal work starts only after it is `active`.

## In-place v16 cutoff

The cutoff retains `singleton` and limits v16 to local schema backfill plus
normal user-Kernel provisioning:

1. Migration v16 runs against the retained `singleton` and backfills
   `account_identities` from its existing account tables.
2. It inserts each login-capable account into `user_kernels` with lifecycle
   `provisioning`.
3. Bounded login, callback, adapter, and AppRunner demand paths retry a
   single-flight, idempotent ensure operation for
   `user:<canonical-username>`. Master startup does not fan out over every
   backfilled placement.
4. The target persists and validates its username/uid provisioning marker, sets
   up fresh local runtime coordination, and becomes `active` before serving
   normal traffic.
5. Normal routing has no singleton fallback. V16 does not coordinate
   cross-object runtime copying or destructive cleanup.

Old singleton-local connections, sessions, routes, schedules, OAuth/MCP rows,
device records, process/conversation registry rows, and callback state remain
stored but dormant. The Master must not reconnect, rearm, recover, or serve that
runtime state after the cutoff. Existing Process DO storage is neither copied
nor destroyed and is not implicitly adopted by a new user Kernel.

The cutoff preserves the existing data planes:

- The same R2 binding, bucket, keys, paths, and uid/gid/mode metadata remain in
  use. Missing or malformed metadata fails closed until explicit root repair.
- Existing AppRunner data remains in the deterministic
  `app:<actorUid>:<packageId>` object. Current admission reauthorizes the
  actor and package; no replacement namespace is created. A pre-split props
  record with no `kernelName` is the old implicit `singleton` binding. Its
  first admitted request or daemon alarm resolves the actor's controlling
  human placement, closes stale sockets, reauthorizes the current package and
  daemon grant, and rebinds that same object to
  `user:<owner-canonical-username>`. Personal-agent actors remain subordinate
  accounts and do not receive a user Kernel.
- Existing ripgit repositories and paths remain in place.
- Existing adapter workers, Master adapter-account rows, and identity links
  remain in place. Adapter delivery resolves the live link and active placement
  through the Master.
- Existing ship-scoped uids and gids remain the filesystem ownership keys.

## Other locked simplifications

- No Kernel generations or lifecycle epochs exist before suspension,
  retirement, and reactivation are implemented. Introduce an epoch together
  with those operations if their stale-work model requires one.
- No P-256 placement certificate exists. A username locator selects a candidate
  user Kernel; the target validates its active marker, HMAC, and local session.
- AppRunners use `app:<actorUid>:<packageId>` with no control/data split,
  runtime registry, projection fence, or package epoch. The active user Kernel
  checks current Master package authority before admitting package traffic.
- Adapters route through the Master in both directions. A future measured scale
  optimization may add a bounded in-memory link cache with Master invalidation;
  it must not become another durable authority.
- Login and link-code throttling remains authoritative durable Master state.
  Cloudflare's rate-limit binding may later shed obvious edge abuse, but it does
  not replace identity-security limits.
- Public self-registration and model-mediated admission remain closed until the
  documented multiuser release gates pass.

## Remaining validation and release work

- Exercise v16 on a representative retained `singleton` with root and multiple
  login-capable humans. Cover wake, first login, and linked-adapter demand;
  interruption; retry; concurrent ensures; and activation failure.
- Prove old singleton-local runtime cannot accept traffic, fire schedules,
  resume callback flows, recover routes, or authorize old Process execution.
- Prove existing R2 files and permissions, AppRunner SQLite, ripgit paths,
  adapter accounts, and identity links remain usable without copying or
  renaming.
- Run clean commissioning and upgraded-instance end-to-end flows in addition to
  the targeted schema, routing, authorization, filesystem, adapter, OAuth/MCP,
  Process, and AppRunner tests.
- Complete cross-shard root administration, audit and cost ledgers, lifecycle
  operations, and the adversarial release matrix before public registration.

## Validation commands

```bash
cd gateway && npx tsc --noEmit && npm run test:run
npm run gsv:check && npm test --workspace packages/gsv
cd web && npm run check && npm run test:run && npm run build
cd extension && npm run check && npm run test:run && npm run build
cd cli && cargo fmt --check && cargo test
```
