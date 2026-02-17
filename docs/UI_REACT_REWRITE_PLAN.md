# GSV UI React Rewrite Plan

## Goals

1. Move `gateway/ui` from Lit to React while preserving current behavior.
2. Use Kumo components for all controls and core layout primitives.
3. Keep the app lightweight and fast on desktop and phones.
4. Build a WS-first state model that matches Gateway request/response + event streams.

## Non-goals

1. Changing Gateway protocol.
2. Changing backend RPC method names or payloads.
3. Visual redesign beyond Kumo-based cohesion and responsive improvements.

## Architecture

### Stack

1. React 19 + TypeScript + Vite.
2. Kumo component library (granular imports from `@cloudflare/kumo/components/*` where possible).
3. Zustand for global state (small runtime, selector-based subscriptions).
4. `useSyncExternalStore`-compatible event bus boundary for WebSocket frames.
5. React Router (or existing pathname mapping) for tab routes.

### WS-first state model

Use an event-sourced store with normalized slices, not per-page local state.

1. `connectionSlice`
   - `status`, `error`, handshake metadata, reconnect attempts.
2. `settingsSlice`
   - local UI settings (`gatewayUrl`, `token`, `sessionKey`, `theme`).
3. `chatSlice`
   - `messagesBySession`, `streamByRun`, `toolResultsByCallId`, `typing` state.
4. `sessionsSlice`
   - session registry list + pagination metadata.
5. `channelsSlice`
   - channel/account statuses, QR state, action state.
6. `toolsSlice`
   - tools registry and grouping metadata.
7. `workspaceSlice`
   - directory listing cache by path, open file buffers.
8. `configSlice`
   - last fetched config, saving/error state, optimistic write queue.
9. `cronSlice`, `logsSlice`, `pairingSlice`
   - tab-specific entities.
10. `debugSlice`
   - ring buffer of recent WS events for diagnostics.

### Data flow

1. `GatewayTransport` handles WS connect/reconnect + request correlation.
2. `GatewayRpc` wraps typed request methods.
3. `EventRouter` maps incoming `evt` frames to domain actions.
4. Slices reduce actions into normalized state.
5. Components subscribe to narrow selectors only.

### Why this is elegant for WS

1. One transport, one event router, many slices.
2. Request/response and server-push events converge through one reducer path.
3. We avoid duplicate local state and stale per-view caches.
4. Fine-grained selectors keep render cost low even with high event throughput.

## Performance plan

### Runtime

1. Route-level code splitting for tabs.
2. Virtualized lists for chat/logs/sessions when item counts grow.
3. Memoized markdown + JSON formatting for message blocks.
4. Batch store updates from bursty event streams.
5. Debounced expensive UI work (autoscroll, filter/search, large JSON pretty print).

### Bundle size

1. Prefer granular Kumo imports where tree-shaking is better.
2. Avoid heavy state/query libs beyond Zustand.
3. Keep utility dependencies minimal.
4. Set budget gates:
   - main JS <= 220 KB gzip
   - total CSS <= 120 KB gzip

### Mobile

1. Drawer navigation with safe-area handling.
2. Touch-friendly controls and minimum 16px text in inputs.
3. Avoid layout thrash with fixed-height shells and contained scroll regions.
4. Profile low-end phone CPU for chat stream updates.

## Migration phases

### Phase 0: foundation

1. Scaffold React app entry in `gateway/ui/src/react`.
2. Port shared protocol/types and Gateway client with no behavior changes.
3. Add Zustand store + slices + event router skeleton.
4. Ship side-by-side toggle (`?ui=react`) for safe validation.

Exit criteria:
1. React shell connects and shows connection state.
2. No regression in handshake/reconnect.

### Phase 1: shell + nav + config

1. Port app shell, topbar, navigation, theme handling.
2. Rewrite Config view entirely with Kumo controls.
3. Keep existing Lit app as fallback route.

Exit criteria:
1. Full config parity (all fields/actions).
2. Mobile nav parity and theme parity.

### Phase 2: chat + sessions + channels

1. Port chat timeline, streaming reducer, tool result cards.
2. Port sessions and channels with existing RPC methods.
3. Add virtualization threshold for large message/session lists.

Exit criteria:
1. Chat streaming parity with no dropped deltas.
2. Tool-result rendering parity and overflow-safe layout.

### Phase 3: workspace + cron + logs + pairing + nodes

1. Port remaining tabs using shared card/list primitives.
2. Preserve behavior from existing RPC handlers.
3. Remove Lit-specific view modules after parity signoff.

Exit criteria:
1. All tabs at parity.
2. Lit rendering path no longer used.

### Phase 4: hardening

1. Add lightweight integration tests for critical flows.
2. Performance profiling and bundle budget enforcement.
3. Remove obsolete CSS and legacy code paths.

Exit criteria:
1. Budgets met.
2. Smoke tests pass in CI.

## Testing strategy

1. Unit tests for reducers/event router.
2. Component tests for config forms and chat rendering edge cases.
3. E2E smoke tests:
   - connect/disconnect
   - send chat + stream response
   - config read/write
   - workspace navigation
4. Visual checks on mobile widths (375, 390, 428) and desktop.

## Risks and mitigations

1. Risk: Dual-stack drift during migration.
   - Mitigation: strict feature-flag + parity checklist per tab.
2. Risk: Re-render storms from chat stream updates.
   - Mitigation: normalized message state + selector subscriptions + batched updates.
3. Risk: Bundle growth from Kumo + React + legacy coexistence.
   - Mitigation: short coexistence window and periodic bundle audits.

## Immediate next tasks

1. Implement `src/react/main.tsx` + `AppShell` + routing scaffold.
2. Build `GatewayTransport` + typed store slices.
3. Migrate Config tab first to Kumo controls.
4. Add parity checklist document for each tab migration.
