# Semantic workspace

The workspace helps a person understand the people, concepts, files and active
work relevant to the conversation they are having. It can compose the available
screen from those sources while keeping the person's navigation authoritative.

## First complete flow

1. Observe a committed message without delaying delivery.
2. Extract source-backed mentions with the selected generative model.
3. Retrieve candidate pages from the person's existing wiki.
4. Evaluate independent relevance, identity and novelty questions with a typed
   decision model. TypeSafe Jev is the first provider.
5. Show linked concepts and related knowledge. Enrich new entries with the
   generative model, retaining the message reference and distinguishing reported
   claims from established knowledge.
6. Optionally compose the workspace from conversation, process, knowledge, file
   and media views. Pinned views and explicit navigation win over model choices.

## Ownership

`ai.decide` is a capability underneath CodeMode and the public protocol. The
Kernel authorizes it and resolves owner-scoped credentials; the inference
executor owns provider execution, cancellation and installation admission.
It does not join the conversational model fallback stack.

Knowledge workflows use the existing repository and filesystem primitives.
Wiki pages remain human-owned ordinary files. Derived observations retain their
source identity and revision; repeated delivery must not create duplicate work.

The web client owns layout and rendering. The model selects only supplied source
identities and supported layouts. It cannot supply executable HTML, grant access,
change a process's identity or replace the active conversation's destination.
Manual navigation, dismissal, pinning and cancellation invalidate older decisions.

## Interface

The person can see what a concept means, where it was mentioned, what knowledge
already exists and whether enrichment is still pending. Primary actions are open
a source, correct a page, pin or dismiss a view, pause automatic composition and
return to Ship. Existing Memory, Fleet, conversation and media renderers retain
their jobs; workspace composition does not create alternative editors.

The layout uses the full content area beneath the shared Instrument header,
adapts to narrow screens and preserves input focus and unsent drafts. Enrichment
and view selection run independently of message delivery.

## Current execution scope

Enable **workspace** in Zen's header. The browser observes the latest committed
message and invokes `wiki context <conversation-id> <message-sequence>`, then
`wiki enrich` when discovery identifies useful new knowledge. Jev evaluates
matching and usefulness together; the generative model extracts exact source
spans and writes the notes. A separate Jev call chooses the visible sources and
layout. The default conversation stays available before decisions complete.

Observations live in `.context/messages/<source-hash>.json` inside the human's
personal wiki. Notes retain their source message and attribution. Both cache
updates and new pages use the repository head as a concurrency fence; existing
pages are never overwritten. Repeat requests reuse completed source records.
Lookup currently uses lexical repository search followed by semantic judgment.
It links existing pages and creates new notes; it does not merge fresh facts
into existing pages or maintain a separate alias/embedding index.

This first version runs while the workspace is enabled in an open browser.
A newer message cancels the old browser request. Already saved discovery can
resume when revisited, but there is no continuous subscription, background
queue or replay of every message while the browser is closed. That is the next
runtime step, independent of layout selection.

Only observed files, message attachments, accessible process summaries and
resolved wiki pages enter the candidate set. Model output cannot choose a raw
URL or arbitrary filesystem path. Opening a process conversation is an explicit
human action. Pausing composition keeps knowledge enrichment active; disabling
workspace stops both browser-owned tasks.

## Delivery and validation

Build in an isolated worktree. Keep the existing development previews intact.
The maintainer owns execution of tests, typechecks, builds and live trials for
this work. Add focused regression cases and provide the commands and a test entry
point when the implementation is ready. No production activation is part of this
batch.

Focused regression sources cover provider response validation, credential scope,
request cancellation and late output, source-backed wiki writes and revision
conflicts, and composition that preserves pins and excludes unknown views.
They have not been executed by the implementation agent.

The isolated preview runner is `workers/gateway/scripts/workspace-preview.mts`.
It runs a development-only localhost directory with real Kernel, Process,
inference executor and ripgit storage. All space data is disposable and separate
from production. The only simulated service is the installation directory and
unused messaging adapters; model responses and repository operations are real.
The TypeSafe key is supplied only to the inference Worker as a secret. The Vite
server can serve only files under this checkout.

After installing dependencies and building SDK JavaScript, supply paths to a
private environment file containing `TYPESAFE_API_KEY`, built ripgit entrypoint,
and existing web assets:

```bash
GSV_TYPESAFE_ENV_FILE=/private/path/typesafe.env \
GSV_PREVIEW_RIPGIT_MAIN=/path/to/ripgit/build/index.js \
GSV_PREVIEW_ASSETS_DIR=/path/to/web/dist \
node --import tsx workers/gateway/scripts/workspace-preview.mts
```

Wrangler uses the operator's existing Cloudflare authentication for the remote
Workers AI binding. The runner starts the browser UI on localhost:5184 and prints
the local onboarding link. No model calls are made by the startup script.

Maintainer validation commands (from the checkout root):

```bash
npm run gsv:build
npm run protocol:check
npm test --workspace packages/inference -- test/decisions.test.ts
cd workers/gateway
npx tsc --noEmit
npx vitest run src/kernel/decisions.test.ts src/kernel/capabilities.test.ts src/inference/decision-client.test.ts src/drivers/native/shell/wiki-context.test.ts
cd ../../web
npm run check
npm run test:run -- src/app/services/workspace/workspaceService.test.ts
```

For the human trial, send a message with a named person and a substantive concept,
turn on workspace, and open a detected concept. Observe pending notes becoming
source-attributed pages in Memory, revisit the message, pin a view, type a draft,
and switch away while a decision is pending. Narrow the window to inspect the
stacked layout. Try a cancelled enrichment and a concurrent edit to its saved
record; neither may overwrite the newer state.
