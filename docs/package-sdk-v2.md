# package sdk v2

This document defines the proposed v2 package SDK shape for GSV packages.

It is intentionally example-first. The goal is to make the package model easy
to understand from a few small entrypoint files instead of from one large,
mixed runtime object.

Examples in this document are proposed API shapes, not a statement that the
current SDK already exports these exact symbols.

## goal

The v2 SDK should make the package surface split cleanly into three things:

- `src/package.ts`: declarative manifest
- backend entrypoint: worker-side RPC, signals, optional HTTP routes
- browser entrypoint: UI code loaded by the fixed shell
- CLI entrypoints: commands run explicitly by the user or platform

This matches the assembly v2 direction in:

- [package assembly v2](/home/hank/theagentscompany/gsv/docs/package-assembly-v2.md:1)

## design rules

- `src/package.ts` stays declarative
- browser entrypoints are JavaScript / TypeScript modules, not HTML
- backend and CLI entry modules use their default export as the entrypoint
- browser-owned assets live next to the browser entrypoint under `browser.assets`
- backend may declare `public_routes` as exact path auth exceptions
- every backend path not listed in `public_routes` remains session-authenticated
- backend built-ins use reserved method names instead of a large `app` object
- package-owned durable state is explicit, not implicit
- the platform shell owns browser bootstrap and static app HTML
- browser framework dependencies stay explicit; JSX packages must declare
  `preact` instead of relying on hidden platform injection

## default export convention

The manifest should point at modules, not at `module + export name` pairs.

That means:

- `backend.entry: "./src/backend.ts"` is enough
- `commands.sync: "./src/cli/sync.ts"` is enough

The default export of each entry module becomes the entrypoint automatically.

This keeps the manifest smaller and removes the need for a separate `export`
field unless GSV later decides it truly needs multiple entrypoints per module.

## manifest example

`src/package.ts` should describe the package and point at the entry modules.
It should not contain the backend implementation itself.

```ts
/**
 * Package manifest.
 *
 * This file is declarative.
 * Use it to describe:
 * - package metadata
 * - capabilities
 * - browser entry module
 * - backend entry module
 * - CLI command entry modules
 *
 * Do not put runtime logic here.
 */
import { definePackage } from "@gsv/package/manifest";

export default definePackage({
  meta: {
    displayName: "Notes",
    description: "A small notes app with a browser UI and sync command.",
    capabilities: {
      kernel: ["fs.read", "fs.write"],
    },
  },
  browser: {
    entry: "./src/main.tsx",
    assets: ["./src/styles.css"],
  },
  backend: {
    entry: "./src/backend.ts",
    public_routes: ["/webhooks/github"],
  },
  cli: {
    commands: {
      sync: "./src/cli/sync.ts",
    },
  },
});
```

## backend entrypoint

The backend entrypoint runs on the worker side.

Use it for:

- RPC methods called by the browser app
- kernel-facing logic
- optional package-specific HTTP routes
- optional signal handling

The entry module default export should be the backend class.

```ts
/**
 * Package backend entrypoint.
 *
 * Runs on the worker side.
 * Use this for:
 * - custom RPC methods called by the browser app
 * - kernel requests
 * - optional package-specific HTTP routes
 * - optional signal handlers
 *
 * Built-in callbacks:
 * - fetch(request): handle package HTTP routes
 * - onSignal(ctx): react to app/platform signals
 *
 * Bindings available on `this`:
 * - this.kernel.request(call, args): make kernel requests
 * - this.meta: { packageName, packageId, routeBase }
 * - this.viewer: authenticated user identity for session-backed requests;
 *   absent on routes declared in `backend.public_routes`
 * - this.app: { sessionId, clientId, rpcBase, expiresAt } for browser-app
 *   requests
 * - this.storage.sql: package-scoped SQLite access when the package declares
 *   the storage capability
 * - this.daemon: daemon scheduling helpers when daemon support is available
 *
 * The default export of this module is the backend entrypoint.
 * Public methods other than reserved built-ins become callable RPC methods.
 */
import { PackageBackendEntrypoint } from "@gsv/package/backend";

export default class NotesBackend extends PackageBackendEntrypoint {
  /**
   * Custom RPC method.
   *
   * Browser clients can call this through the backend client helper.
   */
  async ping(args: { name?: string }) {
    return {
      message: `hello ${args.name ?? "world"}`,
    };
  }

  /**
   * Another custom RPC method.
   *
   * Backend code can use kernel access directly.
   */
  async saveNote(args: { path: string; content: string }) {
    await this.kernel.request("fs.write", {
      path: args.path,
      content: args.content,
    });
    return { ok: true };
  }

  /**
   * Built-in override: custom HTTP handling.
   *
   * Override this only when the package needs explicit HTTP routes such as:
   * - `/api/health`
   * - `/api/export`
   * - `/webhooks/...`
   * - file downloads
   *
   * The manifest may declare `backend.public_routes` as exact paths that may
   * reach this method without app-session auth. Every other path remains
   * session-authenticated by default.
   */
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/webhooks/github")) {
      await verifyGithubSignature(request, GITHUB_WEBHOOK_SECRET);
      const event = request.headers.get("x-github-event");
      const payload = await request.json();
      await this.handleGithubWebhook(event, payload);
      return new Response("ok");
    }

    if (!this.viewer) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (url.pathname.endsWith("/api/health")) {
      return Response.json({
        ok: true,
        package: this.meta.packageName,
        user: this.viewer.username,
      });
    }
    return new Response("Not Found", { status: 404 });
  }

  /**
   * Built-in override: signal handling.
   *
   * Override this when the package wants to react to platform or app signals.
   */
  async onSignal(ctx: { signal: string; payload: unknown }) {
    if (ctx.signal === "notes:refresh") {
      // refresh caches, reschedule work, or trigger backend-side reactions
    }
  }

  async handleGithubWebhook(event: string | null, payload: unknown) {
    await this.kernel.request("signal.emit", {
      signal: "notes:github-webhook",
      payload: { event, payload },
    });
  }
}
```

### backend built-in overrides

The backend class should reserve a small set of method names for platform
hooks.

#### `fetch(request)`

Use this for package-owned HTTP endpoints.

Good uses:

- health endpoints
- exports and downloads
- webhook receivers
- explicit REST-like APIs when RPC is not the right transport

Do not use this to serve the package app HTML shell. The platform owns that.

#### `backend.public_routes`

Use `backend.public_routes` in the manifest to declare exact backend paths that
may bypass app-session auth and still reach `fetch(request)`.

Example:

```ts
backend: {
  entry: "./src/backend.ts",
  public_routes: ["/webhooks/github"],
}
```

Rules:

- `public_routes` is package policy, not a full route table
- paths are exact strings in v1, not globs
- every path not listed there remains session-authenticated by default
- package code is responsible for route-specific safety checks such as signature
  verification or provider auth

#### backend bindings

The backend entrypoint can build on top of these bindings:

- `this.kernel.request(call, args)`: call kernel syscalls from worker-side code
- `this.meta`: inspect package identity and route metadata
  `{ packageName, packageId, routeBase }`
- `this.viewer`: access the current authenticated viewer when one exists
  `{ uid, username }`
- `this.app`: inspect the active browser app session when the call came from a
  browser app `{ sessionId, clientId, rpcBase, expiresAt }`
- `this.storage.sql`: package-scoped SQLite access when the package declares a
  storage capability; v1 should treat this as one logical database per
  `AppRunner` identity, not as arbitrary Durable Object access
- `this.daemon`: manage daemon schedules when the backend is running in a
  daemon-capable environment with `upsertRpcSchedule(...)`,
  `removeRpcSchedule(...)`, `listRpcSchedules()`, and schedule trigger metadata

The backend does not get an implicit Durable Object facet by default.

If a package needs durable state, it should declare that explicitly and receive
it through a modeled binding such as `this.storage.sql`, rather than by
depending on hidden runtime topology.

#### `onSignal(ctx)`

Use this to react to platform or package signals.

Good uses:

- refresh or invalidate derived state
- react to watches
- kick background work
- handle cross-surface package events

#### custom RPC methods

Other public methods should be treated as backend RPC methods.

Good uses:

- `ping`
- `saveNote`
- `search`
- `startImport`

This keeps RPC explicit in the backend class instead of burying it under
`app.rpc`.

## browser entrypoint

The browser entrypoint runs inside the fixed GSV app shell.

Use it for:

- rendering UI
- talking to the package backend
- reading boot or session state exposed by the shell

The browser entrypoint does not own the top-level HTML document.

```tsx
/**
 * Package browser entrypoint.
 *
 * Runs in the browser shell.
 * Use this for:
 * - rendering UI
 * - connecting to the package backend
 * - reading boot data exposed by the platform shell
 *
 * Browser helpers available from `@gsv/package/browser`:
 * - getAppBoot(): package/app boot metadata for this browser session
 * - hasAppBoot(): test whether boot metadata is available
 * - connectBackend<T>(): connect to the package backend RPC client
 *
 * Framework note:
 * - if this file uses JSX, declare `preact` in package.json
 * - the compiler may emit `preact/jsx-runtime`, but the package must own that
 *   dependency explicitly
 *
 * Browser entrypoints do not get direct kernel access.
 * Use the backend when the UI needs privileged or kernel-facing work.
 *
 * The fixed shell owns the HTML document and root container.
 */
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { connectBackend, getAppBoot } from "@gsv/package/browser";

type NotesBackendClient = {
  ping(args: { name?: string }): Promise<{ message: string }>;
  saveNote(args: { path: string; content: string }): Promise<{ ok: true }>;
};

function App() {
  const boot = getAppBoot();
  const [message, setMessage] = useState("loading...");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const backend = await connectBackend<NotesBackendClient>();
      const result = await backend.ping({ name: "preact" });
      if (!cancelled) {
        setMessage(result.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      const backend = await connectBackend<NotesBackendClient>();
      await backend.saveNote({
        path: "notes/today.md",
        content: "# Today\n\nSaved from Preact.\n",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <main>
      <h1>{boot.packageName}</h1>
      <p>{message}</p>
      <button type="button" onClick={handleSave} disabled={saving}>
        {saving ? "Saving..." : "Save note"}
      </button>
    </main>
  );
}

render(<App />, document.getElementById("app")!);
```

### browser notes

- the shell provides the root HTML
- the shell provides boot data
- browser code talks to kernel-facing functionality through the backend, not
  through a direct browser kernel binding
- the browser entrypoint can import declared package assets such as CSS only if
  the SDK/runtime chooses to support that later
- for v1 assembly v2, package CSS should continue to be declared in
  `browser.assets`

### browser helper bindings

The browser SDK should stay small and explicit:

- `getAppBoot()`: returns boot metadata such as `packageId`, `packageName`,
  `routeBase`, `rpcBase`, `sessionId`, `clientId`, `expiresAt`, and
  `hasBackend`
- `hasAppBoot()`: lets browser code guard against missing bootstrap state
- `connectBackend<T>()`: returns the typed backend RPC client for this app
  session

## CLI command entrypoint

CLI command modules should also use their default export as the entrypoint.

Use them for:

- sync jobs
- import/export operations
- admin flows
- explicit automation tasks

```ts
/**
 * Package CLI command entrypoint.
 *
 * Runs as a package command.
 * Use this for:
 * - automation
 * - import/export work
 * - sync jobs
 * - package-specific admin tooling
 *
 * Bindings available on `ctx`:
 * - ctx.argv: command arguments
 * - ctx.stdin.text(): read stdin as text
 * - ctx.stdout.write(text): write stdout
 * - ctx.stderr.write(text): write stderr
 * - ctx.kernel.request(call, args): make kernel requests
 * - ctx.meta: { packageName, packageId, routeBase }
 * - ctx.viewer: { uid, username } for the invoking user
 *
 * The default export of this module is the command handler.
 */
import { defineCommand } from "@gsv/package/cli";

export default defineCommand(async (ctx) => {
  const target = ctx.argv[0] ?? "notes/today.md";
  const existing = await ctx.kernel
    .request<string>("fs.read", { path: target })
    .catch(() => "");

  await ctx.stdout.write(`syncing ${target}\n`);

  await ctx.kernel.request("fs.write", {
    path: target,
    content: `${existing}\nSynced.\n`,
  });
});
```

### CLI bindings

CLI entrypoints can build on top of:

- `ctx.argv`: positional CLI arguments
- `ctx.stdin.text()`: read standard input as text
- `ctx.stdout.write(text)`: write command output
- `ctx.stderr.write(text)`: write error output
- `ctx.kernel.request(call, args)`: perform kernel-facing operations
- `ctx.meta`: package identity and route metadata
  `{ packageName, packageId, routeBase }`
- `ctx.viewer`: the authenticated user running the command `{ uid, username }`

## route ownership

One important rule should stay explicit:

- the platform shell owns browser app bootstrap
- package backend `fetch()` owns package-specific HTTP routes
- `backend.public_routes` only decides which of those routes may bypass
  app-session auth

Routing should work conceptually like this:

1. platform shell and static package asset routes
2. session check unless the path is listed in `backend.public_routes`
3. package backend `fetch()` fallback

That means:

- `fetch()` should not return the browser `index.html`
- browser apps do not need to self-host their shell HTML
- package HTTP routes stay optional
- public backend routes are explicit exceptions, not the default

## why this is better than the current broad `app` object

The current package worker surface mixes several concerns together:

- browser entry declaration
- asset declaration
- RPC methods
- fetch handling
- signal handling

That shape makes the manifest do too much and makes the runtime contract harder
to explain.

The proposed v2 split is simpler:

- manifest declares entry modules
- backend class owns worker-side behavior
- browser module owns UI
- CLI modules own commands

This is easier to assemble, easier to test, and easier to document.

## tentative module split

The SDK likely wants a clearer module layout too:

- `@gsv/package/manifest`
- `@gsv/package/backend`
- `@gsv/package/browser`
- `@gsv/package/cli`

The exact symbol names can still change during implementation. The important
part is the contract shape, not the final file layout spelling.
