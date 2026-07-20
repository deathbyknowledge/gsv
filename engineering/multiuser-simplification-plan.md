# Multiuser simplification execution plan

Working plan for rebuilding the `multi-user-dos` branch as a clean Master +
user-Kernel split with no projection/fence/generation machinery. Delete this
file (or fold its remnants into `docs/architecture/`) once executed.

Base: branch `multi-user-dos` @ `3fb7d8a2` (merge-base with main: `88a5aea1`).
Validation baseline at branch tip: `npx tsc --noEmit` clean, 107 test files /
1679 tests green.

---

## 0. Locked decisions

These are agreed and must not be relitigated during execution:

1. **No durable replicas.** The Master (`singleton`) is the only store for
   accounts, groups, capabilities, config, packages, identity links, tokens,
   placements. User Kernels hold **zero** copies of that state — no
   projections, no snapshots, no digests, no revisions. Authority is resolved
   by RPC at connect/spawn/validation time.
2. **No kernel generations.** Lifecycle transitions (suspend/retire/reactivate)
   have no production entrypoint, so generations guard scenarios that cannot
   occur. Deleted end to end (v019, marker field, edge header, per-generation
   capability, app-session field, process boundary checks). When admin
   lifecycle ops ship, an epoch is introduced *in that same change*.
3. **No placement certificates.** A DO wake + reject is an acceptable cost,
   always. The edge parses the routed session id and forwards; the target
   validates its HMAC and local session and rejects garbage. No edge crypto,
   no signing keys, no SPKI publishing.
4. **No package/AppRunner fences.** AppRunner reverts to its pre-split shape
   (`app:<uid>:<packageId>`, single object, no control/data split, no epochs,
   no registry). Package authority is a plain Master RPC check at
   authorization time. The package authority model is redesigned in the
   upcoming package refactor from a blank page.
5. **Rate limiting stays in-DO.** Cloudflare's rate-limit binding is
   per-location, eventually consistent, 10s/60s windows only, and carries no
   lockout state — wrong semantics for login and link-code budgets. A CF
   edge binding may be added later as a volumetric complement; not a
   replacement.
6. **Adapters route through the Master** in both directions, honestly
   documented. The scale evolution (ephemeral in-memory link cache in user
   Kernels, Master push on link/unlink, lazy pull on miss) is documented as
   future work, not built.
7. **`account.get` public syscall** is the identity-resolution surface.
8. **Clean from scratch.** Migrations renumbered with zero residue, docs
   rewritten to final state, no comments referencing deleted machinery,
   branch history restructured at the end so the result reads as if the
   deleted approach never existed.

### Micro-decisions (recommendations, flag if you disagree)

- **D1 — Drop the per-generation kernel capability entirely.** It exists to
  prove "the RPC caller is the provisioned `user:<name>` DO." But only our
  own Worker code can obtain DO stubs, our DO code passes `this.name`
  (never client input), and the Master independently checks that the claimed
  source kernel has an `active` placement matching the username. Replace
  with `assertActiveUserKernelSource(sourceKernelName, username)` on every
  user-kernel→Master RPC. Deletes `rotate/verify/authorize/requireLocal*`
  (~150 lines + tests).
- **D2 — Cap legacy app-session sliding renewal** with the same route expiry
  as routed sessions (one-line fix for the unbounded-refresh finding).
- **D3 — Username/uid name resolution may be cached forever** in user-Kernel
  memory. Usernames are immutable and uids are never reused, so
  `uidToName`/`gidToName` is the one dataset that needs no invalidation.

---

## 1. Target architecture (final state)

```
client → /ws/<username>
       → edge: Master.resolveUserKernelRoute(username) → 404 | upgrade
       → Kernel(user:<username>): everything the old singleton did
         (connections, processes, schedules, run routes, media, FS/R2,
         shell, conversations, OAuth flows, devices)
       → Kernel(singleton) RPC only for:
         connect auth · Master-owned syscalls · account.get ·
         auth-file reads · config reads · package validation
```

- `/ws` remains commissioning + v16-`legacy` accounts (they run entirely in
  `singleton`, unchanged).
- The user Kernel constructs **no** AuthStore/CapabilityStore/ConfigStore/
  PackagesStore access paths. (Tables may exist empty from the shared schema;
  no code reads them in user-Kernel mode.)
- Capability checks per request run against the connection's in-memory
  capability set, delivered by the Master at connect.
- Token revocation fencing (v018) is unchanged.
- Login/link-challenge rate limiting (v012, v015) is unchanged.

### Master RPC surface (user-Kernel → Master)

All gated by `assertActiveUserKernelSource` (D1) plus existing rate limits
where applicable:

| RPC | Purpose | Backs |
|---|---|---|
| `authenticateConnection({sourceKernelName, username, args, loginSourceScope})` | password/token auth, returns `{uid, gid, gids, username, home, capabilities, ...}` | `sys.connect` (users, devices, services) |
| `accountGet({username? , uid?})` | directory entry `{username, uid, gid, gids, home, shell, kind, state}`; includes resolved capabilities only when the requester may run as that account (self/owned agents) or is root | `account.get` syscall, `proc.spawn`, cron, FS name resolution |
| `readAuthFile("passwd" \| "group" \| "shadow")` | serialized flat file; `shadow` requires requester uid 0 | `/etc/*` via GsvFs |
| `configGet(key)` / `configList(prefix)` | allowlist-enforced config reads | `/sys/config/*`, shell limits, `ai.config` |
| `validatePackageRuntime({packageId, actorUid, packageUpdatedAt, packageArtifactHash})` | package exists, actor authorized, hash/revision current | appFrame authorization, package-agent spawn |
| `receiveAdapterInbound(envelope)` | resolves identity link, forwards frame to owning kernel (or handles legacy locally) | adapter ingress |
| `resolveUserKernelRoute(username)` | placement lookup for edge | `/ws/<username>`, app routes, OAuth callbacks |
| `dispatchMasterSyscall(frame)` | existing Master-owned forwarding | the allowlist |

Master → user-Kernel RPCs: `serviceAdapterFrame(frame, resolvedIdentity)`
(adapter delivery), existing token-revocation outbox delivery, and the
provisioning RPCs (kept, simplified — see batch 6).

`account.get` joins `MASTER_OWNED_SYSCALLS`; its handler and the internal
spawn path share the same `accountGet` implementation.

---

## 2. Git strategy

1. New working branch `multi-user-clean` at `3fb7d8a2` (current tip — all
   tests green).
2. Execute batches 1–8 below; each batch is one or more commits and leaves
   `npx tsc --noEmit && npm run test:run` green in `gateway/`.
3. Batch 9: docs.
4. Batch 10: final validation, then restructure history into the three
   logical commits — `harden multiuser security boundaries` /
   `split runtime by user kernel` / `document user kernel architecture` —
   via a fresh branch from `88a5aea1` and squashed application. Batch
   commits are scaffolding; they never reach the PR.
5. PR description = sections 0–3 of this document.

---

## 3. Execution batches

### Batch 1 — Master read RPCs + consumer rewiring (additions only)

Add the RPC surface above (mostly exists in heavier form; simplify
`authenticateUserKernelConnection` → `authenticateConnection` returning
capabilities, drop projection pull). Add `account.get` syscall (protocol
types, constant, allowlist, handler).

Rewire user-Kernel consumers off local stores:

- `GsvFs` (`fs/gsv-fs.ts`, `fs/backends/kernel.ts`): `/etc/passwd|group|shadow`
  → `readAuthFile`; `/sys/config/*`, `/sys/users/{uid}/*` → `configGet/List`;
  `/sys/capabilities/*` → `accountGet`-backed. `/proc`, `/dev`,
  `/sys/devices` stay local.
- `AuthStore` name cache (`uidToName`/`gidToName`) → in-memory Map over
  `accountGet` (D3: cache forever).
- `proc.spawn` / cron / `agents.ts`: actor identity + caps via `accountGet`.
- Process `ai.config` path: resolve via `configGet`.
- appFrame authorization (`do.ts` ~8173–8294): package validation via
  `validatePackageRuntime`.
- Shell limits (`drivers/native/shell/*`): via `configGet`.

Tests: new RPC coverage; rewired FS/kernel-auth tests. Projections still
exist and are now redundant; suite stays green.

### Batch 2 — delete the fence complex

Delete from `kernel/do.ts` (line refs from inventory @ `3fb7d8a2`):

- Projection machinery: `receiveMasterProjection` 3883–3931,
  `getUserKernelProjection` 5448–5485, `buildCommittedUserKernelProjection`
  5487–5496, `buildUserKernelProjection` 5703–5811,
  `installUserKernelProjection*` 5812–5896, `reconcilePackageProjectionRuntime`
  5898–5968, `applyUserKernelProjection` 5969–5991,
  `runMasterProjectionMutation*` 5109–5206, `pullAuthorized*Projection`
  3092–3102/3218–3228, `broadcast*Projection` 10288–10369,
  `applyFailedMasterMutationProjectionEffects` / `applyPostDispatchEffects`
  10212–10288, module fns `validateUserKernelProvisioningSnapshot`,
  `userKernelProjectionDigest`, `validatePackageAgentProjectionSecurity`
  12124–12260.
- v21 fence: `consumePackageProjectionFenceAuthorization` 3541–3569,
  `preparePackageProjectionFence`/`refreshPackageProjectionFence` 3569–3669,
  `recoverPackageProjectionFence`/`refreshPackageProjectionFenceInternal`
  3669–3792, `abortPackageProjection*` 3792–3883,
  `runPackageProjectionMutation*` 4649–4730,
  `preparePackageProjectionTarget(s)`/`refreshPackageProjectionTargets`
  4876–4972, `queueMasterPackageFenceRecovery`/`onMasterPackageProjection
  FenceRecoveryDue`/`recoverMasterPackageProjectionFence*` 4972–5207,
  `resolveProcessPackageProjectionFenceAuthority` 7240–7279.
- v22 orchestration: `consumeAppRunnerRuntimeFenceAuthorization` /
  `isControllingAppRunnerRuntimeFenceActive` 3340–3416,
  `appRuntimeRunnersForKernelOwner`/`prepareRegisteredAppRunners`/
  `clearRegisteredAppRunners`/`transitionRegisteredAppRunners`/
  `transitionAppRunnerRuntimeFence`/`purgeAppRunnerRuntimeFence
  Authorizations` 3418–3541, `rememberAuthorizedAppRuntime` 8230–8294,
  `isAuthoritativeLocalAppFrame`/`isMasterPackageRuntimeAuthorized`
  4370–4415, target-admission lease `beginUserKernelTargetOperation`/
  `closeUserKernelTargetAdmission`/`waitForUserKernelTargetOperations`/
  `resolveTargetOperationDrainWaiters` 1255–1434.
- Rewrite `dispatchWithMasterProjectionGate` 9270–9336 → plain
  master-forward + `account.create` provisioning hook.
- `master-syscalls.ts`: delete the four `*_REQUIRING_*` sets; keep
  `isMasterOwnedSyscall` (+ `account.get`).

Delete files: `kernel/projection-state.ts`,
`kernel/app-runtime-registry.ts`, `app-runner/package-runtime-fence.ts`,
and their tests; the `do.test.ts` describe blocks "Kernel package projection
transition", "Kernel AppRunner runtime fence orchestration", "Kernel process
runtime projection", "Kernel user lifecycle fencing" (lifecycle machinery
goes in batch 6; pull any keep-worthy assertions forward first).

Delete store methods: `capabilities.ts:162`, `config.ts:185`,
`packages.ts:1231` `replaceRuntimeProjection`; `auth-store.ts`
`replaceRuntimeDirectory` (+ its test block "runtime directory projection").

### Batch 3 — AppRunner revert + app-surface simplification

- `app-runner.ts` (2555 → ~pre-PR 1158 + split deltas): strip `runtimeEpoch`
  from RPC sigs (201–252), `GsvApiBinding` props, loader keys, daemon stubs,
  operation call sites; delete `#authorizePackageRuntimeFence`,
  `captureAppRunnerRuntimeEpoch`, `#getRuntimeEpoch`. Revert DO naming to
  `buildAppRunnerName(uid, packageId)` → `app:<uid>:<packageId>`; delete
  `app-control-v3:`/`app-data-v2:` naming, `app-runner/schema/control-
  schema.ts`, `app-runner/schema/v002_bind_schedule_authority.ts`. Revert
  `app-daemons.ts` to pre-PR (315 lines). `GsvApiBinding.kernelRequest`
  targets the kernel named in `AppRunnerProps` (new `kernelName` prop)
  instead of hardcoded `singleton`.
- Delete placement certs: `shared/app-placement-certificate.ts`,
  `shared/app-placement-verifier.ts`; do.ts `masterAppPlacementSigningKey`/
  `loadOrCreateMasterAppPlacementSigningKey`/
  `publishMasterAppPlacementVerificationKey` 1595–1663,
  `appPlacementCertificate` 1872–1924, `issueAppPlacementCertificate`
  3985–4042, `parseAppPlacementCertificateGrant` + storage keys
  12080–12114; `index.ts` edge verify 849–859; `placementCertificate` field
  in `protocol/app-session.ts`.
- Simplify routed session id to `gsv1b~username~uid~expiresAt~nonce~sig`
  (drop generation + cert). Edge app routes: parse →
  `resolveUserKernelRoute(username)` → forward; legacy bare UUID →
  `resolveAppSessionKernel` (Master). Target validates HMAC + local session.
- `AppFrameContext`: drop `kernelOwnerUid`, `kernelUsername`,
  `kernelGeneration` (runner naming no longer needs owner qualification).
- D2: cap legacy session sliding renewal.

Tests: delete cert/verifier suites; rewrite `app-runner.test.ts` authority
blocks ("request-scoped runtime authority", "daemon schedule authority",
"GSV API app authority", "package SQL storage isolation"),
`protocol/app-session.test.ts`, `app-sessions.test.ts`, `index.test.ts`
app-session describe.

### Batch 4 — adapter inbound simplification

- Delete grant machinery: do.ts `adapterInboundAuthorizations`,
  `issueAdapterInboundRoute` → replaced by `receiveAdapterInbound` (Master
  resolves link + placement, calls target `serviceAdapterFrame`, or handles
  legacy inline), `consumeAdapterInboundAuthorization` 4119–4177,
  `isMasterAdapterInboundAuthorized`; `shared/adapter-inbound-route.ts`
  reduced to the metadata envelope + validation (keep strict shape checks).
- `index.ts` scoped adapter entrypoints: call Master `receiveAdapterInbound`
  only; drop grant forwarding 1081–1153.
- Keep: link-challenge issuance on unknown identities (Master-local),
  run-route authorization for replies (`sendAdapterMessage` path).

Tests: rewrite do.test.ts "Kernel adapter inbound admission",
`index.test.ts` adapter routing describe, `adapter-inbound-route.test.ts`
(envelope only).

### Batch 5 — delete generations

- v019 column usage: `kernel/processes.ts` (29, 52–55, 71–81, 226, 298),
  `kernel/context.ts:64`, `kernel/proc-handlers.ts:64,248–249`,
  `kernel/agents.ts:412–420,488–489`, `kernel/adapter-handlers.ts:1290–1291`,
  `kernel/sys/oauth.ts:206–209`, `drivers/native/shell/pkg.ts:775–776`,
  `kernel/packages.ts:207–214`.
- do.ts: `processKernelGenerationError` 1663–1680,
  `authorizeCurrentPackageAgentRuntime`/`authorizeRegisteredProcessRuntime`
  generation checks 1680–1823, capability suite (D1) 1476–1593 +
  `USER_KERNEL_CAPABILITY_STORAGE_KEY`, `hasActiveUserKernelGeneration`
  10670–10679, `parseUserKernelGenerationHeader` 12116–12122,
  `isCurrentUserKernelMarker` generation field, generation in
  `issueAppSessionId`/`resolveUserKernelCallbackRoute`/
  `authenticateUserKernelConnection`/`forwardMasterSyscall`.
- `process/do.ts`: `lifecycleFenceGeneration` (298, 1538–1543, 2409–2410)
  + fence-authority paths in `recvFrame`.
- Marker (`user-kernels.ts` 54–62): drop `generation`.
- Edge (`index.ts`): stop stamping `x-gsv-kernel-generation`
  (`buildUserKernelWebSocketRequest` 237–250; keep stripping
  `CF-Connecting-IP` and stamping `x-gsv-login-source-scope`);
  `shared/kernel-names.ts` header constant; OAuth callback routes drop
  `/<generation>` segment (`shared/callback-routes.ts`, index.ts 75–131).
- Delete `kernel/process-generation-fence.test.ts`; rewrite
  `user-kernels.test.ts`, `connect.test.ts`, `sys/oauth.test.ts`,
  `mcp-oauth-fence.test.ts` (v023 binding tests stay, fence assertions go),
  `callback-routes.test.ts`, generation describe blocks in `do.test.ts`.

CLI/extension/web/SDK untouched (verified: no generation references; they
only depend on `/ws/<username>`, which stays).

### Batch 6 — lifecycle machinery reduction

Reduce the transition suite to a single idempotent provisioning path:

- KEEP: `ensureUserKernelProvisioned(SingleFlight)` 5498–5605,
  `completeUserKernelActivation` 5607–5688, `provisionSetupUserKernels`
  5688–5703, marker load/parse, `requireActiveUserKernel`, plus the minimal
  executor provisioning helpers they actually call.
- DELETE: `transitionUserKernelLifecycle`/`commitUserKernelLifecycle
  Transition`/`applyUserKernelLifecycleTargetFence` 2039–2408,
  `consumeUserKernelLifecycleAuthorization`/`isMasterUserKernelLifecycle
  Authorized` 1989–2039/2660–2668, legacy + target fence/recovery loops
  2156–2594, `abortFencedUserKernelProcesses` 2594–2658, activation/rebind
  suite 2671–3340 (`activateUserKernelFromProjection`,
  `restoreProvisioningAfterActivationFailure`,
  `rebindFencedUserKernelProcesses`, `discardPreparedUserKernelExecutors`,
  provisioning/activation authorization maps), `masterLegacyAppRuntimeOwners`/
  `transitionMasterLegacyAppRunners` 4674–4876,
  `resolveProcessLifecycleFenceAuthority` 7181–7237,
  `fenceUserKernelRuntime` 9730–9792, `transitioningUserKernels`.
- `user-kernels.ts`: keep `reserve` (permanent tombstone), `markActive`,
  lifecycle enum (states exist; no transitions). Failed `account.create`
  repair = idempotent re-provision only.

### Batch 7 — schema final

- Delete `kernel/schema/v019_bind_process_kernel_generation.ts`,
  `v021_fence_user_kernel_projections.ts`,
  `v022_register_app_runtimes.ts`. Renumber: v020 → v019
  (`bind_package_security_revisions`, KEEP), v023 → v020
  (`bind_oauth_flow_kernel_owner`). Update `kernel/schema/migrations.ts`.
- Edit `v016_add_user_kernels.ts`: drop `generation` from `user_kernels`.
- App-runner schema: delete v002; `app-runner/schema/migrations.ts` back to
  v001 only; delete `control-schema.ts` (batch 3) and revert
  `schema/runner.ts` export if unused.
- Rewrite `kernel/schema/migrations.test.ts`, `security-migrations.test.ts`
  (drop v019+ cases; keep v009–v015 hostile-data coverage),
  `app-runner/schema/migrations.test.ts`, delete
  `app-runner/schema/security-migrations.test.ts`.

### Batch 8 — kernel-auth backend + stragglers

- `fs/backends/kernel-auth.ts` (projected-shadow sentinel logic): user
  Kernels no longer hold any auth material; `/etc/shadow` is a
  root-only `readAuthFile("shadow")` RPC to the Master. Simplify the
  backend accordingly; rewrite `kernel-auth.test.ts`.
- `fs/backends/process-sources.ts`, `fs/ripgit/client.ts`: drop
  repo-metadata projection inputs (`selectRepoMetadataProjection`,
  `broadcastRepoProjection`); repo authority checks stay Master-side,
  runtime access stays owner-scoped in the user Kernel.
- `shared/app-launch-token.ts`: verify no cert coupling; keep.
- `drivers/native/filesystem.ts`, `fs/refs.ts`, `process/media.ts`
  generation-era guards: audit and strip.

### Batch 9 — docs rewrite (final state, no strikethrough history)

- `AGENTS.md`: rewrite "Runtime invariants" — delete the v21 projection
  paragraph, v22 registry/epoch paragraph, placement-certificate sentence,
  generation fencing paragraph. State the new invariants: Master owns the
  namespace; user Kernels hold no replicas and resolve authority by RPC;
  adapter payloads route through the Master with a bounded lookup;
  unprovisioned/non-active kernels fail closed; lifecycle epochs arrive with
  lifecycle ops.
- `docs/architecture/multiuser-security.md`: rewrite (expect major shrink —
  the fence chapters become "authority is an RPC"; keep the honest
  not-implemented lists).
- `docs/architecture/adapter-model.md`: Master-routed both directions; link
  cache as documented future scale path.
- `docs/architecture/security-model.md`, `index.md`,
  `process-ipc-and-scheduler.md`: final-state edits.
- `docs/architecture/agent-loop.md`: fix archive location (owner-scoped
  internal storage — pre-existing doc bug found in review).
- `docs/reference/routing.md`, `websocket-protocol.md`: drop generation
  header + cert + grant descriptions; document `/ws/<username>` flow and
  Master RPC boundary.
- `docs/reference/syscalls.md`: add `account.get`.
- `docs/reference/configuration.md`, `cli-commands.md`, `package-sdk.md`,
  `r2-storage.md`, `hardware-tools.md`: final-state edits.
- `gateway/TODO.md`: split section now reads — done: clean split, Master
  RPC authority, token fencing, rate limiting; remaining: legacy state
  migration, package refactor (authority model TBD), admin lifecycle ops
  (introduce epochs then), link-cache projection (when measured), CF edge
  rate-limit complement, audit/abuse ledgers.

### Batch 10 — final validation + history

- `cd gateway && npx tsc --noEmit && npm run test:run`
- `npm run gsv:check && npm test --workspace packages/gsv`
- `cd web && npm run check && npm run test:run && npm run build`
- `cd extension && npm run check && npm run test:run && npm run build`
- `cd cli && cargo fmt --check && cargo test`
- Clean-instance end-to-end: fresh `npm run dev`, run commissioning
  (`gsv auth setup`), connect user WS, spawn process, adapter test frame
  via `adapters/test`, app launch smoke. (Required by change discipline §6.)
- Restructure into the 3-commit history; PR description from sections 0–3.

---

## 4. Test disposition summary

**Delete entirely:** `projection-state.test.ts`,
`process-generation-fence.test.ts`, `app-runtime-registry.test.ts`,
`package-runtime-fence.test.ts`, `control-schema.test.ts`,
`app-placement-certificate.test.ts`, `app-placement-verifier.test.ts`,
`app-runner/schema/security-migrations.test.ts`.

**Heavy rewrite:** `do.test.ts` (drop ~6 describe blocks, rewrite 2),
`app-runner.test.ts`, `index.test.ts`, `user-kernels.test.ts`,
`app-session.test.ts`, `schema/migrations.test.ts` (kernel + app-runner),
`kernel/schema/security-migrations.test.ts`, `process/do.test.ts`
(lifecycle fence parts), `packages.test.ts` / `package-agents.test.ts`
(projection validation), `app-daemons.test.ts`, `accounts.test.ts`,
`auth-store.test.ts` (runtime directory), `fs/backends/kernel-auth.test.ts`,
`connect.test.ts`, `sys/setup.test.ts`, `commissioning-e2e.test.ts`,
`rpc-surface.test.ts` (RPC list shrinks), `mcp-oauth-fence.test.ts` /
`sys/oauth.test.ts` / `callback-routes.test.ts` (v023 stays, fences go).

**Keep (untouched):** all v009–v015 security suites (`login-attempts`,
`login-source`, `link-challenges`, `token-revocations`, `auth-store` rest,
`capabilities`, `config-access`, `shadow` via auth tests), `master-syscalls`,
`git-auth`, `repo-authority`, `repo-metadata`, `kernel-names`,
`app-launch-token`, `identity-links`, `sys/*` rest, fs/media/shell/public
suites, `run-routes`, `adapter-handlers`, `routing.test.ts`.

## 5. Explicitly out of scope (future work, documented in batch 9)

- Package authority model + package-owned data redesign (user's package
  refactor). Until then: `validatePackageRuntime` per-call RPC, no cache.
- App sessions not fenced by token revocation (review finding B5) —
  design a `revoke sessions for uid` path in the package/session work.
- Legacy (`v16`) runtime state migration off `singleton`.
- Admin lifecycle ops (suspend/retire/reactivate) — introduce epochs there.
- Adapter link-cache projection for message scale; CF edge rate-limit
  complement; audit/abuse ledgers; cross-shard root administration.

## 6. Risks and rollback

- **appFrame validation becomes a per-call Master RPC** — accepted
  regression for the interim; package backends are low-volume pre-refactor.
  If profiling shows pain, the fix is the package refactor, not a cache.
- **Master unavailability blocks connect/spawn/config/package checks** —
  already true today for connect + all mutations; no degraded-mode loss in
  practice.
- **Batch 2/3 are the entangled ones** — the fence orchestration touches
  provisioning hooks and app authorization; keep batches in order, don't
  squash 2+3.
- Rollback: `multi-user-dos` branch remains untouched until the new branch
  is green end to end.
