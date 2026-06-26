# How to Write a Package App

GSV packages are source-backed apps that can provide browser UI, backend RPC,
signal handlers, package-scoped storage, and optional CLI commands.

## Create the Manifest

Put the package definition in `src/package.ts`:

```ts
import { definePackage } from "@humansandmachines/gsv/sdk";

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

Declare repository access with `repo.*` syscalls when the app needs source,
package, or project repository content:

```ts
capabilities: {
  kernel: ["repo.read", "repo.search", "repo.log"],
},
```

Use `pkg.*` only for package lifecycle actions such as install, sync, checkout,
review approval, or public visibility.

## Add a Backend

Backends extend `PackageBackendEntrypoint`. Public methods are exposed over the
package RPC surface.

```ts
import { PackageBackendEntrypoint } from "@humansandmachines/gsv/sdk";

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
import { connectBackend, getAppBoot } from "@humansandmachines/gsv/sdk";

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

`connectBackend()` caches a stable RPC proxy and retries once after the app
socket disconnects.

## Add a CLI Command

CLI commands are package modules that default-export `defineCommand(...)`:

```ts
import { defineCommand } from "@humansandmachines/gsv/sdk";

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

## Ship Package Source Changes

After changing a package source tree in `/src/repos`:

```bash
rgit diff owner/repo
rgit commit owner/repo --message "update package"
pkg update <package> --ref main
```

To bring upstream GSV changes into a deployed `root/gsv`, use the GSV console's
source/package **Pull upstream** action or call `repo.import` for `root/gsv`.
The pull records `refs/remotes/upstream/<ref>` and fast-forwards the local branch
only when it is safe; if local commits diverged, merge upstream first and then
update the affected packages explicitly.

If you changed the package runtime, SDK, assembler, or Gateway code, redeploy the
infrastructure first:

```bash
gsv infra deploy -c assembler -c gateway
pkg update <package> --ref main
```

For a named deployment, pass the same `--instance NAME` to the infrastructure
deploy command.

Treat package review like code review. Check requested Kernel syscalls,
filesystem writes, shell usage, adapter behavior, and network assumptions before
enabling non-builtin packages.
