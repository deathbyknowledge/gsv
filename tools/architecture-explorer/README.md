# GSV architecture explorer

The architecture explorer is a localhost-only, read-only map of the GSV source
tree for contributors. It is not part of the Web product, does not connect to a
Gateway, and does not read installation or user state.

From the repository root:

```bash
npm run architecture:explore
```

Then open `http://127.0.0.1:4179`. Set `GSV_ARCHITECTURE_PORT` to use another
port.

## The job

The explorer should let a reader answer three questions quickly:

1. Which subsystem owns this behavior, state, and cleanup?
2. Which trust or protocol boundary does a request cross next?
3. Which source files, architecture notes, and tests are evidence for the map?

The world is organized by runtime ownership rather than directory nesting.
Folders are evidence attached to landmarks; they are not treated as runtime
actors. The scene therefore keeps the Kernel, Process, Conversation, target,
adapter, client, and storage owners visually distinct even when their source
paths are close together.

## Controls

- Drag the world or use the arrow keys to orbit.
- Scroll, `+`, or `-` to change scale.
- Select a landmark to inspect its owner, persistence, admission, completion,
  components, source paths, documentation, and tests.
- Double-click a landmark or choose **Fly to** to center it.
- Switch Runtime, Ownership, Security, and Durability lenses to change the
  architectural facts emphasized by the terrain.
- Choose a guided trace to follow one request across its owners.
- Press `/` or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>K</kbd> to search the atlas.
- The selected subsystem and component are kept in the URL hash for sharing.

## Source of truth and drift

`architecture.mjs` is the curated subsystem, component, edge, and guided-flow
graph. `atlas-meta.mjs` adds spatial placement and explicit owner, persistence,
admission, completion, security, documentation, and test evidence.

The map is intentionally authored rather than inferred. Source code and tests
remain authoritative; the explorer explains their boundaries. Run the focused
checks after changing either file:

```bash
npm run architecture:test
```

The tests reject missing or duplicate nodes, broken flow/edge references,
missing repository paths, incomplete ownership metadata, uncovered adapter
manifests, and accidental product-Web coupling.

The local server exposes only an allowlist of explorer assets plus source-link
metadata. Links use the checkout's tracked GitHub remote and branch when one is
available, with a canonical upstream fallback; the tool never offers an
arbitrary repository file API.

## Out of scope

- Live installation health, process state, or configuration
- Editing source, prompts, policies, or runtime data
- Product navigation or deployment through `web/dist`
- A literal 3D rendering of directory size
- Generated claims that silently override owning code or tests
