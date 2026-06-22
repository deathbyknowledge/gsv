# Design System Implementation Spec

> Status: **proposal / for review.** This describes *how* we bring the GSV design
> system (authored in Claude Design) into the GSV codebase. It is scoped to the
> **Web UI (`web/`) only** — built-in packages are deliberately left untouched
> (see §2). The work is **UI-only**; anything that would reach beyond UI is called
> out under **🚩 STRUCTURAL FLAG**. Nothing here is implemented yet.

## 1. Goal & constraints

We are implementing the GSV design system in the **web client**. Ground rules agreed with the design owner:

- **Source of truth:** the **GSV Live** prototype + the design-system atom set + `gsv-tokens.css`, all authored in Claude Design.
- **Two visual worlds, one universe:** **The Desktop** (deep-space view, periwinkle/cyan, restrained generative art) and **The Control Panel** (dark-purple console, monospace, status dots, hand-drawn/dot-matrix glyphs).
- **Incremental, small chunks.** First chunk = the **desktop shell**. Other web surfaces follow one at a time.
- **One clean design system, shared across all of `web/`** — and **only** `web/`. Tokens and ported components live inside the web client and are imported directly. **No sync scripts, no cross-package sharing, no ad-hoc tooling.**
- **Built-in packages are frozen.** We do not restyle them. See §2.
- **Atoms (components) are ported on demand**, into a shared `components/` folder in the web UI.
- **UI-only.** No behavioral, data, protocol, or runtime changes. Anything structural is flagged, not silently done.

## 2. Migration strategy: web absorbs, packages retire

The clean path that avoids all cross-package plumbing: **the new web UI implements the functionality itself**, rather than sharing a design system into the built-in packages.

- **During migration:** built-in packages (`builtin-packages/chat`, `files`, `wiki`, `shell`, `gsv`) are **left exactly as they are.** We do not touch their CSS, tokens, or components.
- **As the web UI grows:** we pull as much of that functionality into the web client as possible, styled natively with the design system.
- **When a package's functionality is covered:** disable it during testing, then eventually **remove it from the built-ins.**

This means the entire design-system effort lives inside `web/`, which is a plain Vite app — so it's pure UI work with no platform/assembler involvement.

### 🚩 STRUCTURAL FLAG — this is a product/architecture direction, not just a restyle *(owner-confirmed; tractable)*

"Web UI implements the same functionality" is a **separate, larger workstream** than applying the design system — re-creating chat / files / wiki / shell / console behavior in the web client touches data flow and feature scope, well beyond CSS. **Confirmed by the design owner**, with the path de-risked:

- **Most logic is reusable from the existing packages.** The package code is the behavioral blueprint — we adapt it rather than reinventing it.
- **Syscalls are already usable from the Web UI.** The web client's `GSVClient` / `GatewayProvider` (`web/src/app/services/gateway/`) already exposes the kernel syscall surface, so replicating a package's backend interactions in web is mostly wiring, not new plumbing.
- **The design prototype + packages together are the spec** for both look and behavior.

So this track is real but not high-risk. Two guardrails remain:

1. **Keep the tracks distinct.** Styling a screen ≠ porting a package's full behavior into web. The **design-system restyle itself stays UI-only**; the functionality migration rides alongside it.
2. **Track the dependency explicitly.** Maintain a "what functionality must web absorb before package X can be disabled/removed" checklist, so a package isn't retired before web covers it.

## 3. The format gap (why this is a *port*, not a *copy-paste*)

The design system is authored in **Claude Design's `.dc.html` runtime**: `<dc-import>`, `<sc-if>`, `{{ }}` value-holes, a `data-props` JSON schema, `support.js`, and `DCLogic` classes. **None of that runtime exists in GSV.** GSV's web UI is **Preact + plain CSS with custom properties** — no Tailwind, no CSS-in-JS, no component library.

So "implement the design system" means **translate each layer into the web client's idioms**:

| Design-system layer | Source artifact | Web target | Effort |
|---|---|---|---|
| **Tokens** | `gsv-tokens.css` (`:root` custom properties) | CSS custom properties — near-verbatim | Mechanical |
| **Atoms** | `Button.dc.html`, `Select.dc.html`, … (~37) | Preact components + CSS in `web/src/.../components/`, ported **on demand** | Per-component |
| **Page templates / screens** | `GSV Live.dc.html`, `Node desktop.dc.html`, … | Restyle the real web screens against ported tokens/atoms | Larger |
| **Icons / illustrations** | `gsv-dot-icons.js`, ASCII `<pre>` planets, raster portraits | Static **SVG/CSS** assets — see §7 | Mixed |

The atom files are still valuable as **exact visual specs**: each `.dc.html` carries literal hex, paddings, letter-spacing, font sizes, and per-state CSS (hover/active/focus/disabled). Porting = transcribing those into a Preact component, not redesigning.

## 4. The token layer (foundation, ships first)

`gsv-tokens.css` is ~50 custom properties on `:root` — surfaces, borders/rules, interaction states, text/accent, status, and action accents. Every other piece references these via `var(--token)`.

**Plan:** vendor `gsv-tokens.css` into the web client (e.g. `web/src/styles/gsv-tokens.css`) as the single foundation file, imported once in `web/src/app/main.tsx`:

```ts
import "./styles/gsv-tokens.css"; // global design tokens — the shared asset for all of web/
import "../styles.css";
// …feature CSS
```

Because `web/` is a single Vite app, this *is* the "global asset shared across the whole UI" — every component and stylesheet under `web/` sees the same `var(--token)` values with zero plumbing. Values come straight from `gsv-tokens.css` and are not re-derived.

### 🚩 STRUCTURAL FLAG — token name collisions inside the web client

The design tokens use **generic, unprefixed names** that already exist with **different values** in `web/src/styles.css` (scoped to `.desktop-shell`):

| Token | Design system value | Web shell value today |
|---|---|---|
| `--accent` | `#b3aeff` | `#8ccdf8` |
| `--danger` / `--warn` | `#a8324a` / `#e0a64c` | `#ff6f6f` / `#f0ca6f` |
| `--text*`, surfaces | dark-purple set | navy set |

This is now contained entirely within `web/` (packages are out of scope). Handling — **needs a decision (Q1)**:

- **Option A — unprefixed, migrate the shell wholesale.** Keep names as authored. The shell's current tokens are scoped to `.desktop-shell` (more specific than `:root`), so old values *shadow* the new ones until each rule is migrated — a single chunk converts the shell cleanly. Matches the design files 1:1.
- **Option B — namespace as `--gsv-*`.** Old and new coexist with zero collision risk, allowing piecemeal migration; costs a one-time rename and diverges from the design files' literal `var()` names.

**Recommendation:** Option A — we're converting the shell wholesale anyway. Pure UI; "structural" only in CSS blast radius.

## 5. Atoms — on-demand Preact port into a shared `components/` folder

No `gsv-ui` package. Atoms are ported **only when a screen being styled needs them**, into a tidy shared folder in the web UI that any web component can import:

```
web/src/app/components/ui/   # shared design-system primitives (Button, Select, Tag, StatusDot, …)
```

Each port:

1. Read the atom's `.dc.html` (props in the `data-props` JSON at the bottom; states/sizes in the `<helmet>` CSS).
2. Implement a Preact component whose props mirror the `data-props` schema.
3. Transcribe the per-state CSS into a stylesheet (literal values as authored; `var(--token)` where the design file references tokens).
4. Preserve handler semantics — `onClick`/`onChange` pass-through, `stopPropagation` where present.

This is the existing `web/` convention (feature-organized Preact + CSS), just with a shared `ui/` folder added for cross-feature primitives. No new infrastructure.

## 6. Typography — self-hosted

Design fonts: **Departure Mono** (primary, console/HUD) + **JetBrains Mono** (mono fallback). Today the web client loads **Space Grotesk + IBM Plex Mono** from Google Fonts in `web/index.html`.

**Plan (per the design owner):** **self-host** the fonts.

- Add the `Departure Mono` woff2 (and JetBrains Mono if we adopt it) under `web/public/fonts/`.
- Declare `@font-face` in the token/base CSS pointing at the local files; drop the Google Fonts `<link>` for the replaced families from `web/index.html`.
- Confirm Departure Mono's license permits redistribution before committing the file. *(This is the one prerequisite to verify — Q2.)*

This is an asset + `<link>`/`@font-face` change only.

## 7. Iconography — static SVG/CSS, never JS

Per the design owner, **icons must be images/CSS, not a JS runtime.** The prototype's `gsv-dot-icons.js` (which sets `window.GSV_DOT` and draws icons at runtime) is **not** ported as-is.

**Plan:**

- **Pre-render each needed dot-matrix icon to a static `.svg` file** (the `[col,row]` cell data in the export is the spec), committed under `web/public/icons/` (or `web/src/assets/icons/`). These are plain committed assets — **not a runtime script and not a sync pipeline.** Generated once from the design data, then they live as files.
- **Render via image/CSS:** use `<img src>` for fixed-color marks, or CSS `mask-image` with `background-color: var(--token)` where an icon must take a theme color. The mask approach gives full token-driven tinting with **no JS**.
- **Raster agent portraits** (`img/agent-*.png`) are plain images — copy into `web/public/`.
- **ASCII planet illustrations** (`AsciiPlanet.dc.html`) are procedurally JS-painted `<pre>` canvases. Per **D4**, these become **static art** (rendered image/CSS), accepting the loss of the procedural animation — no runtime canvas component. Treat as their own later chunk; do not block the shell on them.

## 8. What stays untouched (explicit non-goals)

- **Built-in packages** — frozen; not restyled (§2).
- No protocol/syscall, gateway, assembler, CLI, adapter, or device changes.
- No changes to web data flow, state management, routing, window manager, or providers — restyle only.
- No new dependencies beyond self-hosted font/icon/image assets.
- Behavior, copy, and interactions stay as-is unless the design explicitly changes them (called out per chunk).

## 9. Decisions (locked 2026-06-22)

| # | Decision |
|---|---|
| **D1** | **Token naming: Option A** — keep the design tokens unprefixed and migrate the desktop shell wholesale. The shell's `.desktop-shell`-scoped tokens shadow the new `:root` values until each rule is converted. |
| **D2** | **Self-host fonts.** Departure Mono is **SIL Open Font License 1.1** (Helena Zhang) — *corrected from an earlier note that said MIT*. OFL explicitly permits bundling/embedding/redistribution with software, so self-hosting is fine. Vendored the v1.500 woff2 + LICENSE from the canonical GitHub release (not the prototype's third-party CDN re-host) into `web/public/fonts/`. |
| **D3** | **Chrome first.** Chunk 1 covers the desktop *chrome* (top bar, dock/launcher, windows, command palette, session/login). The **space-view node graph is its own later chunk.** |
| **D4** | **ASCII planet illustrations → static art.** Render to static image/CSS; no runtime canvas component. |

*(Package questions are resolved by §2: packages are left alone — no cross-package token delivery, no shared package, no assembler change.)*

## 10. Proposed phasing (each chunk = its own PR, reviewed against GSV Live)

1. **Tokens + fonts + desktop chrome.** Vendor `gsv-tokens.css`, self-host fonts, and restyle the desktop shell chrome (top bar, dock/launcher, windows, command palette, session/login screens) to the design vocabulary. Port only the atoms these screens use into `components/ui/`.
2. **Desktop space view.** Node network, orbital links, starfield, responsive collapse-to-left-rail, persistent chat panel + resize. (Largest; isolate per Q3.)
3. **Remaining web surfaces** + absorbing built-in-package functionality into web (per §2), one surface at a time, retiring packages as their functionality lands.
4. **Illustrations/icons** as needed by the above (static icon SVGs early; ASCII planets per Q4).

---

### Appendix — key code references

- Web UI entry & CSS imports: `web/src/app/main.tsx`, `web/src/styles.css`
- Web fonts (to self-host): `web/index.html` (`<link>` to Google Fonts) → `web/public/fonts/`
- Desktop feature components to restyle: `web/src/app/features/desktop/*`
- Session/login screens: `web/src/app/features/session/*`
- Package frontend conventions (for reference; packages are frozen): `engineering/package-frontend-architecture.md`
- Design tokens (source of truth): `gsv-tokens.css` (from the Claude Design export)
