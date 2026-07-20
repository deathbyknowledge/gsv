# Multiuser simplification — working state (read this first after compaction)

Strategy doc: `engineering/multiuser-simplification-plan.md`. This file is the
living execution state. Update it at each checkpoint.

## Where we are

- Branch: `multi-user-clean` (off `multi-user-dos` @ `3fb7d8a2`, merge-base with main `88a5aea1`).
- `cc71046c` — "resolve master reads by rpc, drop kernel capability": **green checkpoint** (107 files, 1676 tests).
- `2f08dbae` — WIP mid raw-delete. **`gateway/src/kernel/do.ts` does NOT compile** (~60 dangling-reference errors, all listed below with treatments).
- Plan amendment approved by user: work mode is **raw delete + repair** (delete machinery, then fix every dependent via tsc/tests), not careful additive-then-delete.
- Backup of do.ts before raw delete: `/tmp/opencode/do.ts.bak`.
- AST method deleter (robust, use this — do NOT use regex/brace matching):
  `node /tmp/opencode/delete_methods.cjs <file> <MethodName...>`

## Locked decisions (user-confirmed, do not relitigate)

1. **No durable replicas/projections.** Master (`singleton`) is the only store for accounts/groups/caps/config/packages/links/tokens/placements. User Kernels resolve authority by RPC: public syscalls `account.get`, `sys.config.get` (+`explicit` mode), `sys.cap.list`, `pkg.list`, `repo.list`; internal RPCs `masterReadAuthFile`, `masterPackagesList`.
2. **No kernel generations** until lifecycle ops ship (re-add an epoch with them).
3. **No P-256 placement certificates.** DO wake+reject is acceptable; target validates HMAC+session.
4. **No package/AppRunner fences/registry/epochs.** AppRunner reverts to pre-split shape (`app:<uid>:<packageId>`); package authority = dumb Master RPC until the user's package refactor.
5. **Rate limiting stays in-DO** (CF rate-limit binding is per-colo/eventually-consistent/10-60s windows — wrong semantics; optional future edge complement).
6. **Adapters route through the Master both directions**, documented honestly. Future scale path: ephemeral in-memory link cache in user kernels with Master push.
7. **`account.get`** is the identity-resolution surface (public syscall; `capabilities`/`personalAgentUid` only when caller may run-as; `delegable` = canOwnerDelegateRunAs).
8. **D1: per-generation kernel capability DELETED.** Master trusts user-kernel RPCs iff claimed `sourceKernelName` parses as `user:<canonical>` with an `active` or `provisioning` placement matching uid/generation. Rationale: only gateway code can obtain DO stubs; our code passes `this.name`.
9. **HARD CUTOVER on legacy** (user confirmed): no `legacy` lifecycle mode. v016 rewritten to provision + migrate existing accounts at upgrade. ALL legacy branches deleted.
10. **Clean from scratch**: migrations renumbered with zero residue, docs rewritten to final state, branch history restructured into 3 commits at the end (`harden multiuser security boundaries` / `split runtime by user kernel` / `document user kernel architecture`).

## Done and verified

- Syscalls: `account.get` (+`delegable`, +`personalAgentUid`), `sys.cap.list` (own gids + gid<1000; root all), `sys.config.get` explicit mode. All master-owned.
- Master RPCs in do.ts: `masterReadAuthFile` (passwd full; group member-filtered for non-root with gid-0 emptied; shadow root-only via root's own kernel), `masterPackagesList` (full records, visibility scopes). Guards: `assertActiveUserKernelSourcePlacement`, `assertUserKernelRequester` (uid 0 only from user:root; else owner or runnable-by-owner), `authorizeUserKernelSource`.
- `KernelContext` Master-read methods (dual impl local/RPC): `accountGet`, `readAuthFile`, `configGet`, `configList`, `configListExplicit`, `capsList`, `packagesList`, `listRepos` (+`dispatchMasterRead` helper in buildKernelContext; `accountGetForIdentity` for kernel-built identities, gated to active markers).
- FS layer fully async: `KernelRefs` (fs/refs.ts) async auth/config/caps/packages; `GsvFs.backendForPath` async; `MountBackend.handles` may be async; backends rewritten: kernel.ts, account-home.ts (delegation gate = `account.get` capabilities presence), packages.ts, process-sources.ts (lazy `listRepos`).
- ai.ts: `withAiConfigSnapshot` shims `{...ctx, config: snapshot}` at handler entries (`handleAiConfig`, `resolveAiTextGenerationConfig`, `resolveAiMediaContext`); snapshot preserves get/getExplicit semantics via `configListExplicit` + local SYSTEM_CONFIG_DEFAULTS overlay.
- Shell name cache via `readAuthFile`+parse (metadata.ts).
- `repo.list` is master-owned; rgit/wiki/process-sources use `ctx.listRepos()`.
- D1 capability suite fully deleted (types, storage keys, parsers, hash helpers, ~40 call sites, test suites rewritten).
- `buildProcessContext` + provisioning executor resolve caps via `accountGetForIdentity` (skipped while marker not `active` — Master mid-transition refuses calls during provisioning, which is why provisioning inputs carry the payload).
- Provisioning rewritten (NO handshake maps/snapshots): `provisionUserKernel` (input = {sourceKernelName, username, uid, generation, ownerIdentity, personalAgent?, capabilities[]}) → Master `markActive` → `completeUserKernelActivation` → `activateProvisionedUserKernel` (validate, flip marker active, `rearmPendingSchedules`). `ensureDefaultConversationExecutor(ctx, human, personalAgent?)` accepts a pre-resolved agent.
- Deleted files: projection-state(+test), app-runtime-registry(+test), package-runtime-fence(+test), control-schema(+test), v002_bind_schedule_authority, app-runner schema security-migrations.test, app-placement-certificate(+test), app-placement-verifier(+test), process-generation-fence.test, kernel schema v019/v021/v022 (v020→v019, v023→v020 renumbered with contents updated).
- Test helpers: `commissionUserKernel` in process/do.test.ts (Master: addUser+addGroup+caps.grant(sys.config.get,account.get)+reserve+markActive; target: marker). Scheduler tests currently use `newMasterScheduleKernel` (Master + seeded `legacy` placement) — **must be revisited after legacy cutover** (master-side legacy scheduling disappears; move those two tests to commissioned user kernels).

## CURRENT BROKEN STATE — do.ts error regions and treatments

All remaining tsc errors are dangling references; treatments:

- `456`, `890`: `PackageProjectionFenceAuthorizationInput` type references (my regex deletion missed) → delete the type + refs.
- `911`: `MasterAppPlacementSigningKey` field → delete.
- `1014-1036`: `beginMasterUserOperation`/`applyMasterUserKernelLifecycle` remnants with `appRuntimes`/`fenceUserKernelRuntime`/`closeUserKernelTargetAdmission` → strip those checks; delete `applyMasterUserKernelLifecycle` if still present.
- `1131`: `requireActiveUserKernel` — strip `appRuntimes.getLifecycleFence` check (keep active-lifecycle check).
- `1201-1276`: `isCurrentUserKernelMarker` — strip `projectionState.packageFence()` checks.
- `1335`: `issueAppSessionId` — strip `appPlacementCertificate(...)`; routed id becomes `gsv1b~username~uid~expiresAt~nonce~signature` (no generation/cert — coordinate with protocol/app-session.ts rewrite below).
- `1869-1983`: `authorizeCurrentPackageAgentRuntime` + `authorizeRegisteredProcessRuntime` + appFrame authority (`isMasterPackageRuntimeAuthorized`, `rememberAuthorizedAppRuntime`, `beginUserKernelTargetOperation` refs) → **rewrite**: delete runtime-authority stamps/fences; package validation = target calls Master by RPC (`validatePackageRuntime` semantics: package exists+enabled+reviewed, artifact hash matches, actor authorized). Package-agent principal reads (package-agents.ts `packageAgent*Key` config stamps) go through the same Master RPC — add internal RPC e.g. `masterPackageAgentPrincipal(uid)` if needed.
- `2340-2422`: `dispatchWithMasterProjectionGate` → rewrite to plain `forwardMasterSyscall` + the `account.create`→`ensureUserKernelProvisioned` hook; delete `queueMasterPackageFenceRecovery`/`applyFailedMasterMutationProjectionEffects`/`applyPostDispatchEffects` call sites.
- `2596-2633`: `runMasterProjectionMutation`/`broadcastRepoProjection` callers (repo metadata mutation) → perform mutation directly, no broadcast.
- `2686+` provisioning remnants — verify matches rewritten flow above (already rewritten; leftover refs to deleted maps/fields deleted in this pass).
- Any remaining `this.appRuntimes.*` / `this.projectionState.*` refs (oauth/mcp/app-session/adapter paths) → strip.
- `UserKernelLifecycleAuthorizationInput`, `userKernelLifecycleAuthorizations`, `USER_KERNEL_LIFECYCLE_AUTHORIZATION_TTL_MS`, `transitioningUserKernels` usage in lifecycle paths → delete with lifecycle machinery (keep `transitioningUserKernels` ONLY for `beginMasterUserOperation` provisioning-window guard used by dispatchMasterSyscall).
- `kernelProjectionOperation`/lease plumbing in `buildKernelContext` (`targetOperation`, `isPackageProjectionOperation`, `markPackageProjectionOperation`, `expectedKernelGeneration`) → strip; `assertCurrentKernel` keeps only marker-current check.

## Remaining file work (after do.ts compiles)

- `app-runner.ts`: full revert — strip `runtimeEpoch` everywhere (RPC sigs ~201-252, `GsvApiBinding` props, loader keys, daemon stubs, `captureAppRunnerRuntimeEpoch`, `#getRuntimeEpoch`, `#authorizePackageRuntimeFence`); DO naming back to `buildAppRunnerName(uid, packageId)` → `app:<uid>:<packageId>`; `GsvApiBinding.kernelRequest` targets kernel from new `AppRunnerProps.kernelName` instead of hardcoded `singleton`; delete v3/data-object split remnants and `runnerRole` gating tied to fence.
- `app-runner/schema/migrations.ts`: remove v002 import+registration (v001 only).
- `app-daemons.ts`: revert to pre-split (~315 lines; drop authority columns/logical_key).
- `protocol/app-session.ts`: routed id `gsv1b~username~uid~expiresAt~nonce~sig`; drop `placementCertificate`+`generation` fields; `buildAppRunnerName` 2-arg; cap legacy-UUID session sliding renewal (D2: same route expiry as routed).
- `protocol/app-frame.ts`: drop `kernelOwnerUid`, `kernelUsername`, `kernelGeneration` from `AppFrameContext`.
- `index.ts`: delete cert edge verify (~849-859) + `app-placement-verifier` import; app routes: parse routed id → `resolveUserKernelRoute(username)` → forward; legacy bare UUID → Master `resolveAppSessionKernel` (simplify: Master looks up its local session store); `/ws/<username>` forward stops stamping `x-gsv-kernel-generation` (keep stripping `CF-Connecting-IP`, keep stamping `x-gsv-login-source-scope`); OAuth callback routes drop `/<generation>` segment (callback-routes.ts too).
- `shared/kernel-names.ts`: drop `USER_KERNEL_GENERATION_HEADER`.
- `process/do.ts`: delete `lifecycleFenceGeneration` (298, ~1538, ~2409) + generation/fence authority checks in recvFrame; keep everything else.
- `kernel/processes.ts`, `context.ts`, `proc-handlers.ts`, `agents.ts`, `adapter-handlers.ts`, `sys/oauth.ts`, `drivers/native/shell/pkg.ts`, `kernel/packages.ts`: strip `kernelGeneration` refs.
- `kernel/capabilities.ts:162`, `kernel/config.ts:185`, `kernel/packages.ts:1231`: delete `replaceRuntimeProjection`; `auth-store.ts` `replaceRuntimeDirectory` (+ its test block).
- `kernel/master-syscalls.ts`: delete the four `*_REQUIRING_*` sets; keep `isMasterOwnedSyscall`.
- `kernel/package-agents.ts`: delete `validatePackageAgentProjectionSecurity`; projection consumers → Master RPC.
- `fs/backends/kernel-auth.test.ts` sentinel-shadow logic: user kernels hold NO auth material; `/etc/shadow` is root-only `readAuthFile("shadow")` RPC — already handled; adjust test expectations if stale.

## Legacy cutover (confirmed — do it after compile)

- Rewrite `kernel/schema/v016_add_user_kernels.ts`: drop `generation` column; provision every existing login-capable human at migration (reserve + activate) instead of inserting `legacy` rows; cutover routine copies durable runtime state singleton→user kernels (schedules, oauth accounts, MCP servers, devices, conversation metadata) + `proc.kill` sweep (archives history, destroys Process DOs). Ephemeral state (run routes, app sessions, flows) dropped by design.
- Delete ALL legacy branches: `resolveUserKernelRoute` legacy branch, `handleSysConnect` master legacy admission, `appRequest` `beginMasterLegacyOwnerOperation`, `serviceFrame` singleton relay, `isLegacyAppSessionId`/`resolveAppSessionKernel` legacy UUID acceptance, `runScheduleRecord` master branch, `user_kernels.lifecycle` `'legacy'` state, scheduler.test.ts's `newMasterScheduleKernel` legacy seed (replace with commissioned user kernels).
- `/ws` becomes commissioning-only.

## Adapter inbound simplification

Delete grant machinery: `adapterInboundAuthorizations`, `issueAdapterInboundRoute` → `receiveAdapterInbound` (Master resolves link+placement, calls target `serviceAdapterFrame` directly — Master→kernel RPC is intrinsically trusted), `consumeAdapterInboundAuthorization`, `isMasterAdapterInboundAuthorized`. `shared/adapter-inbound-route.ts` reduced to envelope+validation (keep strict shape checks). `index.ts` scoped adapter entrypoints call Master only.

## Test repair (after code compiles)

- Delete describes in do.test.ts: "Kernel user lifecycle fencing", "Kernel adapter inbound admission", "Kernel package projection transition", "Kernel AppRunner runtime fence orchestration", "Kernel process runtime projection". Rewrite: "Kernel user provisioning admission" (handshake gone), "Kernel package app authorization".
- Rewrite: app-runner.test.ts authority blocks; index.test.ts (3 describes); user-kernels.test.ts; app-session.test.ts; app-sessions.test.ts; mcp-oauth-fence.test.ts (v023 binding stays); sys/oauth.test.ts; callback-routes.test.ts; connect.test.ts; accounts.test.ts; packages/package-agents tests (projection validation gone); app-daemons.test.ts; schema/migrations.test.ts (kernel+app-runner); kernel/schema/security-migrations.test.ts (drop v019+ cases, keep v009-v015 hostile-data); rpc-surface.test.ts (allowlist shrank); auth-store.test.ts ("runtime directory projection" block); commissioning-e2e.test.ts; sys/setup.test.ts; proc-handlers/processes tests; adapter-handlers.test.ts; process/do.test.ts (lifecycle fence parts); run-routes.test.ts; git-auth.test.ts (transition barrier refs); do.test.ts "Kernel user lifecycle fencing" etc. as above.

## Shell CLI feature (after refactor lands — user request)

New native shell command in `gateway/src/drivers/native/shell/` exposing account creation + user capabilities to root and permitted users (syscalls exist: account.create/list/get, sys.cap.list). Follow existing command patterns (ls.ts, proc.ts, pkg.ts — `requireCommandCapability`). Suggested: `account` with subcommands create/list/get/caps. Note: account.create is callable by all users today (agent creation); root sees all.

## Docs (final state, no history-of-deleted-things)

- AGENTS.md: delete v21/v22 paragraphs, generation fencing, placement cert, adapter grant language. New invariants: Master owns namespace; user Kernels hold no replicas, resolve authority by RPC; adapters Master-routed; unprovisioned/non-active kernels fail closed; epochs arrive with lifecycle ops.
- docs/architecture/multiuser-security.md: rewrite (major shrink).
- adapter-model.md: Master-routed both directions; link cache as documented future.
- security-model.md, index.md, process-ipc-and-scheduler.md, agent-loop.md (fix stale archive location: owner-scoped internal storage, not home dir), routing.md, websocket-protocol.md, syscalls.md (add account.get, sys.cap.list), configuration.md, cli-commands.md, package-sdk.md, r2-storage.md, hardware-tools.md.
- gateway/TODO.md: split section → done; remaining = package refactor (authority TBD), admin lifecycle ops (+epochs), link cache (when measured), CF edge rate-limit complement, audit/abuse ledgers, cross-shard admin.

## Final validation + history

- `cd gateway && npx tsc --noEmit && npm run test:run`
- `npm run gsv:check && npm test --workspace packages/gsv`
- `cd web && npm run check && npm run test:run && npm run build`
- `cd extension && npm run check && npm run test:run && npm run build`
- `cd cli && cargo fmt --check && cargo test`
- Clean-instance e2e: `npm run dev`, `gsv auth setup`, user WS connect, spawn, adapter test frame, app launch smoke.
- Restructure history into 3 commits; PR description = plan sections 0–3.

## Key facts

- SDK rebuild required after protocol edits: `cd packages/gsv && npm run build`.
- Master calls from a target are refused while its username is mid-provisioning (`beginMasterUserOperation`) — hence provisioning inputs carry ownerIdentity/personalAgent/capabilities.
- `authorizeUserKernelSource` accepts `active` AND `provisioning` placements.
- New RPC methods must be added to `KERNEL_RPC_METHOD_ALLOWLIST` (do.ts ~800); `masterReadAuthFile` + `masterPackagesList` already added.
- User-kernel test commissioning = marker on target + account/placement/caps on Master (see `commissionUserKernel`).
- Process caps resolve per-frame via `accountGetForIdentity` in `buildProcessContext`.
