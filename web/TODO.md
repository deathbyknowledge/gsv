# UI TODO

## Foundations
- [x] Replace old experimental UI with clean shell baseline.
- [x] Make desktop app launcher registry-driven (`src/apps.ts`).
- [x] Add OS theme registry + runtime theme switching (`src/themes.ts`).
- [x] Persist selected UI theme in local storage.
- [x] Move shell state out of `main.ts` into small modules (`shell-template`, `window-manager`, `theme-service`).

## Theme System
- [x] Add core theme families: Frutiger Aero, Skeumorphism, Flat Design, Neumorphism, Glassmorphism, Neubrutalism.
- [x] Define strict token schema contract (required tokens + optional extension tokens).
- [ ] Add theme previews and metadata (author, version, contrast score, tags).
- [ ] Support import/export for theme packs.
- [ ] Add per-theme motion profile (reduced, calm, expressive).

## Desktop Shell
- [x] Draggable mock window baseline.
- [x] Window manager v1: focus, z-index, minimize, maximize, close, restore.
- [x] Window resize handles and snap regions.
- [x] Multi-window layout persistence (restore on refresh).
- [x] Desktop icon interactions: single/double click behavior and keyboard activation.

## App Runtime
- [x] Define app manifest shape (id, name, icon, entrypoint, permissions, window defaults).
- [x] Build launcher that opens windows from manifest, not hardcoded mock content.
- [x] Add app lifecycle hooks (`mount`, `suspend`, `resume`, `terminate`).
- [x] Add app crash boundary and restart UX.
- [x] Introduce UI App SDK contract (`src/app-sdk`) with manifest validator, scoped kernel client, and theme client.
- [x] Add component-app runtime adapter (`entrypoint.kind = component`) for Web Component apps.

## Auth + Session UX
- [x] Build desktop-style login screen (username/password) that exchanges for short-lived session token.
- [x] Add session refresh and expiration handling.
- [x] Add lock screen flow.
- [ ] Add setup-mode UX path for first boot.

## Permissions + Security UX
- [ ] Design permission prompt model (app-scoped capability requests).
- [ ] Add permission center app for grant/revoke/audit.
- [ ] Show clear provenance for adapter/channel-originated events.
- [ ] Add signed app trust indicator in launcher/window chrome.

## Visual + Interaction Quality
- [ ] Replace placeholder glyphs with real icon pipeline (SVG sprite or icon packs).
- [ ] Add intentional motion system (window open/close, focus transitions, desktop feedback).
- [ ] Add wallpaper service and per-theme wallpaper packs.
- [ ] Add typography scale system tuned per theme family.
- [x] Theme desktop scrollbars to match active visual token set.

## Accessibility + Performance
- [ ] Keyboard-first navigation for desktop icons, topbar controls, and windows.
- [ ] High-contrast mode and text scaling support.
- [ ] Reduced motion support across all animations.
- [ ] Performance budget and profiling pass (low-end laptop baseline).

## Integration
- [x] Add browser gateway client transport (`sys.connect`, `proc.send`, `proc.history`, signal routing).
- [x] Wire Chat app to live gateway flows (history load, send path, streaming responses).
- [x] Render assistant messages as sanitized Markdown.
- [x] Add structured tool call/result cards with tool-specific output views.
- [x] Migrate Chat to SDK component runtime (`gsv-chat-app`) while preserving behavior.
- [x] Build real Control app config panel (`sys.config.get`/`sys.config.set`) with filter + edit workflow.
- [x] Hook UI to real gateway-os websocket client.
- [ ] Replace mock kernel status with live connection/session/process indicators.
- [ ] Add first real apps: Chat, Shell, Process Monitor, Files.
- [ ] Add e2e smoke tests for login -> launch app -> send action -> receive response.
