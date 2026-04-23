# Write a Package App

GSV package apps are split into three explicit entrypoint types:

- `src/package.ts`: declarative manifest
- `backend`: worker-side RPC, HTTP routes, signals, and package state
- `browser`: browser UI entry module
- `cli`: optional command entry modules

## Start with the manifest

`src/package.ts` stays declarative. It describes the package and points at the
modules the platform should load.

```ts
import { definePackage } from "@gsv/package/manifest";

export default definePackage({
  meta: {
    displayName: "Notes",
    description: "Simple note taking package",
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

Rules:

- `browser.entry` must be a JS/TS module, not HTML
- `backend.entry` points at the default-export backend class
- `cli.commands[name]` points at the default-export command handler
- paths in `backend.public_routes` are exact public auth exceptions
- every backend path not listed in `public_routes` remains session-authenticated

## Add a backend

The backend runs on the worker side. Use it for:

- RPC methods called from the browser
- optional HTTP routes through `fetch()`
- signal handling through `onSignal()`
- kernel access through `this.kernel`
- package-scoped SQLite through `this.storage.sql`

```ts
import { PackageBackendEntrypoint } from "@gsv/package/backend";

export default class NotesBackend extends PackageBackendEntrypoint {
  async listNotes() {
    return this.kernel.request("fs.list", { path: "/notes" });
  }

  async saveNote(args: { path: string; content: string }) {
    await this.kernel.request("fs.write", args);
    await this.storage?.sql.exec(
      "INSERT INTO note_log(path, updated_at) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET updated_at = excluded.updated_at",
      args.path,
      Date.now(),
    );
    return { ok: true };
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/webhooks/github")) {
      const payload = await request.json();
      await this.kernel.request("signal.emit", {
        signal: "notes:webhook",
        payload,
      });
      return new Response("ok");
    }
    return new Response("Not Found", { status: 404 });
  }

  async onSignal(ctx: { signal: string; payload: unknown }) {
    if (ctx.signal === "notes:refresh") {
      await this.listNotes();
    }
  }
}
```

## Add a browser app

The browser entrypoint renders into the fixed platform shell. Package apps do
not own the HTML document.

If you use JSX, declare `preact` in `package.json`. The assembler rewrites JSX
to `preact/jsx-runtime`, but it does not inject `preact` as a hidden
dependency.

```tsx
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { connectBackend, getAppBoot } from "@gsv/package/browser";

type NotesBackend = {
  listNotes(): Promise<string[]>;
  saveNote(args: { path: string; content: string }): Promise<{ ok: true }>;
};

function App() {
  const [notes, setNotes] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const backend = await connectBackend<NotesBackend>();
      const next = await backend.listNotes();
      if (!cancelled) {
        setNotes(next);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <h1>{getAppBoot().packageName}</h1>
      <ul>{notes.map((path) => <li key={path}>{path}</li>)}</ul>
    </main>
  );
}

render(<App />, document.getElementById("root")!);
```

`connectBackend()` returns a stable client proxy. If the backend RPC websocket
dies, the helper reconnects automatically on the next call and retries the
request once for transport-level disconnects.

## Add a CLI command

CLI commands are optional. They are normal modules whose default export is a
command handler.

```ts
import { defineCommand } from "@gsv/package/cli";

export default defineCommand(async (ctx) => {
  const target = ctx.argv[0] ?? "/notes/today.md";
  await ctx.stdout.write(`syncing ${target}\n`);
});
```

## Public routes

Use `backend.public_routes` only when a backend path must bypass app-session
auth, for example third-party webhooks.

Example:

```ts
backend: {
  entry: "./src/backend.ts",
  public_routes: ["/webhooks/github"],
}
```

That setting only controls auth bypass. Routing still belongs to
`backend.fetch()`.

## Package state

Backends can use package-scoped SQLite through `this.storage.sql.exec(...)`.

Notes:

- storage is scoped to the package runtime identity managed by `AppRunner`
- SQL access is asynchronous from package code because it crosses the runtime
  boundary through RPC
- package code should avoid using system-reserved tables

## Ship the change

If you changed a builtin package:

```bash
git push <remote> HEAD:main
cargo run -- -u root packages sync
```

If you changed the package runtime or SDK as well:

```bash
cd assembler && npm run deploy
cd ../gateway && npm run deploy
cd .. && cargo run -- -u root packages sync
```
