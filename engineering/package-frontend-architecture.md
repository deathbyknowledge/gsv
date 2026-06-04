# Package Frontend Architecture

Builtin packages are examples for future user-authored packages. Hold their frontend structure to a high standard.

Do not let a package grow into a few huge files such as:
- `app.tsx` owning backend loading, subscriptions, media lifecycle, dialogs, and all JSX
- `components.tsx` containing every component in the app
- `view-helpers.ts` mixing domain reducers, payload normalization, DOM helpers, storage, markdown, and formatters
- one `styles.css` with thousands of lines

## Preferred Structure

Prefer a feature-oriented hierarchy once an app has more than one real surface:

```text
src/app/
|-- main.tsx
|-- app.tsx                 # composition and cross-feature wiring only
|-- types.ts                # shared app model types
|-- components/
|   |-- layout/
|   |-- navigation/
|   |-- <feature>/
|   `-- ui/
|-- hooks/                  # stateful runtime behavior and browser APIs
|-- domain/                 # pure reducers, normalization, model rules
`-- utils/                  # generic formatters, guards, storage, clipboard
```

Use these responsibility boundaries:
- `app.tsx`: compose layout, wire feature hooks, pass callbacks, handle truly cross-feature actions
- `components/*`: render UI and local interaction; avoid backend calls except through callbacks
- `hooks/*`: own backend loading, subscriptions, timers, refs, media lifecycle, browser APIs, and host bridge state
- `domain/*`: pure transformations, reducers, payload normalization, model rules, and feature-specific helpers
- `utils/*`: generic formatting, type guards, markdown, clipboard, storage, and DOM helpers
- `backend/*`: package backend wrappers and syscall argument normalization

## Hook Seams

Common hook seams include:
- catalog/list loading, such as profiles, workspaces, devices, processes, conversations
- history pagination and scroll anchoring
- live process/app signal reconciliation
- media source loading, object URL/data URL state, retry errors, and cleanup
- file attachments and previews
- browser recording APIs such as `MediaRecorder`
- desktop-shell or host bridge target events
- selection, filters, and persisted UI state

## Component Splits

Split components by product surface, not by generic UI category alone.

Good folders include:
- `navigation/`
- `conversation/` or another domain feature name
- `transcript/`
- `media/`
- `composer/`
- `archive/`
- `ui/` for truly shared primitives only

## CSS

Keep `src/styles.css` as the asset entrypoint and split feature CSS under `src/styles/*`:

```css
@import "./styles/base.css";
@import "./styles/navigation.css";
@import "./styles/<feature>.css";
@import "./styles/responsive.css";
```

If `src/package.ts` declares explicit `browser.assets`, list every imported CSS partial there. The runtime can only serve assets it knows about.

## Refactor Order

When refactoring an existing app, preserve behavior first:

1. inventory file sizes and symbols
2. split pure/domain helpers first
3. split feature components second
4. extract coherent stateful hooks third
5. reduce `app.tsx` to integration and composition
6. split CSS last without changing selectors
7. validate after each risky boundary

Useful inspection commands:

```bash
find builtin-packages/<app>/src -maxdepth 4 -type f -print0 | xargs -0 wc -l | sort -nr
rg -n "^(export\\s+)?(function|const|type|interface)\\s+" builtin-packages/<app>/src
```

For frontend-only package refactors, a useful import-graph check is:

```bash
npx esbuild builtin-packages/<app>/src/app/main.tsx --bundle --platform=browser --format=esm --jsx=automatic --jsx-import-source=preact --external:@gsv/package/* --outfile=/tmp/gsv-<app>-main.js
```

If the app uses a different browser entry, read `src/package.ts` and use that path. Do not rely on a repo-wide builtin TypeScript check if it is already failing for unrelated package/module-resolution reasons.
