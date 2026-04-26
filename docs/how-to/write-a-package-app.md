# How to Write a Package App

GSV packages are source-backed apps that can provide browser UI, backend RPC,
signal handlers, package-scoped storage, and optional CLI commands.

## Create the Manifest

Put the package definition in `src/package.ts`:

```ts
import { definePackage } from "@gsv/package/manifest";

export default definePackage({
  meta: {
    displayName: "Notes",
    description: "Simple notes backed by the GSV filesystem.",
    capabilities: {
      kernel: ["fs.read", "fs.write", "fs.search"],
    },
    window: {
      width: 900,
      height: 640,
    },
  },
  browser: {
    entry: "./src/main.tsx",
    assets: ["./src/styles.css"],
  },
  backend: {
    entry: "./src/backend.ts",
  },
  cli: {
    commands: {
      notes: "./src/cli/notes.ts",
    },
  },
});
```

`browser.entry` is a JS/TS module, not an HTML document. Backend and CLI paths
point to modules with default exports.

## Add a Backend

Backends extend `PackageBackendEntrypoint`. Public methods are exposed over the
package RPC surface.

```ts
import { PackageBackendEntrypoint } from "@gsv/package/backend";

export default class NotesBackend extends PackageBackendEntrypoint {
  async listNotes() {
    return this.kernel.request("fs.read", { path: "/home/notes" });
  }

  async saveNote(args: { path: string; content: string }) {
    await this.kernel.request("fs.write", args);
    await this.storage?.sql.exec(
      "INSERT INTO note_log(path, updated_at) VALUES (?, ?)",
      args.path,
      Date.now(),
    );
    return { ok: true };
  }
}
```

Useful backend bindings:

- `this.kernel.request(call, args)` issues granted Kernel syscalls.
- `this.storage.sql.exec(...)` stores package-scoped SQLite state.
- `this.viewer` identifies the authenticated user for session-backed requests.
- `this.daemon` manages package daemon schedules when available.

## Add Browser UI

The browser entry renders into the platform shell. If you use JSX, declare
`preact` in the package dependencies.

```tsx
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { connectBackend, getAppBoot } from "@gsv/package/browser";

type NotesBackend = {
  listNotes(): Promise<{ files: string[]; directories: string[] }>;
};

function App() {
  const [files, setFiles] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const backend = await connectBackend<NotesBackend>();
      const result = await backend.listNotes();
      if (!cancelled) setFiles(result.files ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <h1>{getAppBoot().packageName}</h1>
      <ul>{files.map((file) => <li key={file}>{file}</li>)}</ul>
    </main>
  );
}

render(<App />, document.getElementById("root")!);
```

`connectBackend()` caches a stable RPC proxy and retries once after a transport
disconnect.

## Add a CLI Command

CLI commands are package modules that default-export `defineCommand(...)`:

```ts
import { defineCommand } from "@gsv/package/cli";

export default defineCommand(async (ctx) => {
  const target = ctx.argv[0] ?? "/home/notes";
  const result = await ctx.kernel.request("fs.read", { path: target });
  await ctx.stdout.write(JSON.stringify(result, null, 2) + "\n");
});
```

Package commands run with the authenticated viewer identity and the package's
declared grants.

## Add Background Work

For package-owned recurring work, schedule backend RPC methods with
`this.daemon.upsertRpcSchedule(...)`:

```ts
await this.daemon?.upsertRpcSchedule({
  key: "refresh-cache",
  rpcMethod: "refreshCache",
  schedule: { kind: "every", everyMs: 60 * 60 * 1000 },
  enabled: true,
});
```

Use `kind: "at"`, `kind: "after"`, or `kind: "every"`. The scheduled method
receives the stored payload, and `this.daemon.trigger` describes the invocation.

## Ship Built-in Package Changes

After changing a built-in package source tree:

```bash
git push <remote> HEAD:main
gsv packages sync
```

If you changed the package runtime, SDK, assembler, or Gateway code, redeploy the
infrastructure first:

```bash
gsv infra deploy -c assembler -c gateway
gsv packages sync
```

Treat package review like code review. Check requested Kernel syscalls,
filesystem writes, shell usage, adapter behavior, and network assumptions before
enabling non-system packages.
