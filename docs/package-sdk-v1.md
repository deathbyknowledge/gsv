# package sdk v1

This document defines the v1 package authoring contract for GSV packages.

It is intentionally opinionated.

- Packages are JS/TS/JSX/TSX only.
- Packages use standard `package.json` for npm dependencies.
- Packages declare runtime behavior through `definePackage(...)`.
- Packages share one stable package state root.
- Packages may expose commands, one app, and background tasks.

This spec is for authoring, analysis, build, and runtime integration.

## goals

- Make package authoring clear for first-party and third-party developers.
- Avoid unnecessary files and duplicate metadata.
- Support npm dependencies naturally.
- Keep package runtime safe, deterministic, and easy to analyze statically.
- Cover command-only, app-only, mixed, and background-task packages with one model.

## non-goals

- Arbitrary language support.
- Arbitrary user-defined build pipelines in the kernel install path.
- Raw Durable Object APIs exposed to package authors.
- Raw kernel object access exposed to package authors.

## package layout

Minimal package layout:

```text
my-package/
├── package.json
├── src/
│   └── package.ts
└── ui/
    └── ...
```

Recommended package layout:

```text
my-package/
├── package.json
├── src/
│   ├── package.ts
│   ├── app.tsx
│   ├── commands/
│   └── tasks/
├── ui/
│   ├── index.html
│   └── icon.svg
└── README.md
```

Rules:

- `package.json` is required.
- `src/package.ts` is required.
- `ui/` is optional.
- Additional files are allowed.

## metadata split

There is no separate `gsv-package.json` in v1.

Metadata is split between:

- `package.json`
- `definePackage(...)`

### `package.json` owns

- npm package identity
- npm dependency declarations
- optional package-manager fields
- optional build config needed by ripgit tooling

Example:

```json
{
  "name": "@acme/rss-reader",
  "version": "0.1.0",
  "type": "module",
  "dependencies": {
    "hono": "^4.8.0"
  }
}
```

### `definePackage(...)` owns

- package display metadata
- commands
- app entrypoint
- tasks
- runtime capabilities
- app window defaults
- icon path
- optional package setup logic

Reason:

- runtime behavior belongs next to package code
- npm dependency metadata belongs in `package.json`
- we avoid an extra manifest file

## static extraction rule

`definePackage(...)` must be statically analyzable.

That means:

- the default export must be a top-level `definePackage({...})` call
- the object passed to `definePackage(...)` must be a literal object
- metadata fields must be literals or literal arrays/objects
- entrypoint handlers may reference imported/local code normally

Allowed:

```ts
export default definePackage({
  meta: {
    displayName: "RSS Reader",
    icon: "./ui/icon.svg",
  },
  commands: {
    "rss-list": listFeeds,
  },
});
```

Not allowed:

```ts
const meta = loadMetaSomehow();
export default definePackage(meta);
```

Reason:

- ripgit package tooling must be able to parse package metadata without executing untrusted code

## package module api

Packages export one default package definition:

```ts
import { definePackage } from "@gsv/package-worker";

export default definePackage({
  meta: { ... },
  setup(ctx) { ... },
  commands: { ... },
  app: { fetch(request, ctx) { ... } },
  tasks: { ... },
});
```

### shape

```ts
type PackageDefinition = {
  meta: PackageMeta;
  setup?: SetupHandler;
  commands?: Record<string, CommandHandler>;
  app?: AppDefinition;
  tasks?: Record<string, TaskHandler>;
};
```

### `meta`

```ts
type PackageMeta = {
  displayName: string;
  description?: string;
  icon?: string;
  window?: {
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
  };
  capabilities?: {
    kernel?: string[];
    outbound?: string[];
  };
};
```

Rules:

- `displayName` is required.
- `icon` is optional and package-relative.
- `window` only matters if the package exposes an app.
- `capabilities` are explicit declarations, not inferred truth.

## entrypoint kinds

v1 supports three entrypoint kinds:

- `command`
- `app`
- `task`

### commands

Commands are package-provided binaries.

- one package may expose multiple commands
- commands share package state
- commands are mounted into the shell command surface

Example:

```ts
commands: {
  doctor: async (ctx) => {
    await ctx.stdout.write("ok\\n");
  },
  "rss-list": async (ctx) => {
    const rows = await ctx.package.sqlQuery<{ url: string }>(
      "select url from feeds order by url",
    );
    for (const row of rows) {
      await ctx.stdout.write(`${row.url}\\n`);
    }
  },
}
```

### app

An app is an HTTP-serving package entrypoint.

v1 supports at most one app per package.

Reason:

- keeps package discovery and window routing simple
- still covers the expected use cases

Example:

```ts
app: {
  async fetch(request, ctx) {
    return new Response("hello");
  },
}
```

### tasks

Tasks are named background units of work.

- one package may expose multiple tasks
- tasks may be run immediately or via schedule
- tasks share package state

Example:

```ts
tasks: {
  refreshFeeds: async (ctx) => {
    const feeds = await ctx.package.sqlQuery("select * from feeds");
    // fetch and store updates
  },
}
```

Important rule:

- alarms are a runtime delivery mechanism
- tasks are the author-facing programming model

## setup

`setup` is optional and idempotent.

Typical use:

- create sqlite tables
- backfill package-local defaults
- register or repair recurring schedules

Example:

```ts
setup: async (ctx) => {
  await ctx.package.sqlExec(`
    create table if not exists feeds (
      id integer primary key,
      url text not null unique
    )
  `);
}
```

Expected runtime behavior:

- `setup` runs before first package use
- it may also run after checkout/source changes
- it must be safe to run more than once

## server-side sdk contexts

All server-side entrypoints share a base context.

```ts
type BaseContext = {
  meta: {
    packageName: string;
    packageId: string;
    routeBase: string | null;
  };
  package: {
    sqlExec(statement: string, params?: unknown[]): Promise<void>;
    sqlQuery<T = Record<string, unknown>>(statement: string, params?: unknown[]): Promise<T[]>;
    runTask(name: string, payload?: unknown): Promise<void>;
    scheduleTask(
      name: string,
      spec: { at?: number; afterMs?: number; everyMs?: number },
      payload?: unknown,
      options?: { key?: string },
    ): Promise<void>;
    cancelTaskSchedule(name: string, options?: { key?: string }): Promise<void>;
  };
  kernel: {
    request<T = unknown>(call: string, args?: unknown): Promise<T>;
  };
};
```

### command context

```ts
type CommandContext = BaseContext & {
  argv: string[];
  stdin: {
    text(): Promise<string>;
  };
  stdout: {
    write(text: string): Promise<void>;
  };
  stderr: {
    write(text: string): Promise<void>;
  };
};
```

### app context

```ts
type AppContext = BaseContext;
```

### task context

```ts
type TaskContext = BaseContext & {
  taskName: string;
  trigger: {
    kind: "manual" | "schedule" | "app" | "command";
    scheduledAt?: number;
  };
  payload: unknown;
};
```

## browser-side sdk

Browser-side package UI uses a separate SDK:

```ts
import { connectHost } from "@gsv/package-host";

const host = await connectHost();
```

The browser-side `HOST` surface is:

```ts
type Host = {
  getStatus(): HostStatus;
  onStatus(listener: (status: HostStatus) => void): () => void;
  onSignal(listener: (signal: string, payload: unknown) => void): () => void;
  request<T = unknown>(call: string, args?: unknown): Promise<T>;
  spawnProcess(args: SpawnArgs): Promise<SpawnResult>;
  sendMessage(message: string, pid?: string): Promise<SendResult>;
  getHistory(limit: number, pid?: string, offset?: number): Promise<HistoryResult>;
};
```

Important boundary:

- browser package code uses `HOST`
- server package worker code uses `kernel` and `package`
- these are different layers and must not be merged

## package state model

Every installed package has one stable package state root.

v1 package state surface includes:

- sqlite query/exec
- task execution
- task scheduling

Package authors do not see a raw Durable Object.

They see:

- `ctx.package.sqlExec(...)`
- `ctx.package.sqlQuery(...)`
- `ctx.package.runTask(...)`
- `ctx.package.scheduleTask(...)`
- `ctx.package.cancelTaskSchedule(...)`

This covers:

- simple binaries
- multiple binaries
- app + binary packages
- app + binary + shared sqlite
- offline/background packages such as RSS polling

## capability model

Capabilities are explicit.

They are declared in `definePackage(...).meta.capabilities`.

Example:

```ts
meta: {
  displayName: "Files",
  capabilities: {
    kernel: ["fs.read", "fs.write", "fs.delete", "fs.search", "sys.device.list"],
    outbound: [],
  },
}
```

Rules:

- manifest declarations are the source of truth
- static tooling may infer likely usage and warn on mismatches
- runtime must still enforce grants/policy

## npm dependency model

Packages may use npm dependencies through standard `package.json`.

This is required for a realistic third-party package story.

Rules:

- dependency metadata lives in `package.json`
- package build tooling resolves and bundles dependencies before runtime loading
- kernel/package runtime does not execute arbitrary package install hooks

Cloudflare already documents this requirement for Dynamic Workers:

- TypeScript and npm dependencies must be transpiled and bundled before loading
- `@cloudflare/worker-bundler` is one reference implementation for that model

Reference:

- https://developers.cloudflare.com/dynamic-workers/getting-started/

## build contract

Ripgit package tooling is responsible for:

- reading `package.json`
- parsing `src/package.ts`
- extracting static package metadata
- validating entrypoints/capabilities
- resolving npm dependencies
- compiling TS/JS/JSX/TSX
- bundling package worker and browser assets
- emitting a normalized `PackageArtifact`

Important constraint:

- packages do not provide arbitrary build scripts for kernel/runtime installs
- package build behavior must stay declarative and deterministic

## examples

### command-only package

```ts
export default definePackage({
  meta: {
    displayName: "Doctor",
  },
  commands: {
    doctor: async (ctx) => {
      await ctx.stdout.write("gsv doctor: status checks are not implemented yet\\n");
    },
  },
});
```

### command + sqlite package

```ts
export default definePackage({
  meta: {
    displayName: "Notes",
  },
  setup: async (ctx) => {
    await ctx.package.sqlExec(`
      create table if not exists notes (
        id integer primary key,
        body text not null
      )
    `);
  },
  commands: {
    "note-add": async (ctx) => {
      const body = await ctx.stdin.text();
      await ctx.package.sqlExec("insert into notes (body) values (?)", [body]);
    },
  },
});
```

### app + commands + tasks package

```ts
export default definePackage({
  meta: {
    displayName: "RSS Reader",
    icon: "./ui/icon.svg",
    window: {
      width: 920,
      height: 640,
    },
    capabilities: {
      kernel: [],
      outbound: ["https://*"],
    },
  },
  setup: async (ctx) => {
    await ctx.package.sqlExec(`
      create table if not exists feeds (
        id integer primary key,
        url text not null unique
      )
    `);
  },
  commands: {
    "rss-refresh": async (ctx) => {
      await ctx.package.runTask("refreshFeeds", { reason: "manual-command" });
      await ctx.stdout.write("refresh started\\n");
    },
  },
  app: {
    async fetch(request, ctx) {
      const url = new URL(request.url);
      if (url.pathname === "/api/refresh" && request.method === "POST") {
        await ctx.package.runTask("refreshFeeds", { reason: "manual-app" });
        return new Response(null, { status: 204 });
      }
      return new Response("Not Found", { status: 404 });
    },
  },
  tasks: {
    refreshFeeds: async (ctx) => {
      const feeds = await ctx.package.sqlQuery("select id, url from feeds");
      void feeds;
    },
  },
});
```

## implementation notes

This spec implies three implementation layers:

1. `@gsv/package-worker`
- exports `definePackage(...)`
- provides server-side types/helpers

2. `@gsv/package-host`
- exports `connectHost()`
- provides browser-side types/helpers

3. ripgit package tooling
- statically analyzes packages
- validates metadata/capabilities
- resolves dependencies
- builds/bundles output

## open questions

These are still intentionally open:

1. Should ripgit tooling generate typed syscall helpers on top of `kernel.request(...)`?
2. How much capability inference should tooling do beyond warnings?
3. Should package-local asset declarations stay implicit by import graph, or gain explicit config later?
4. When do we add async app routing hooks beyond the current synchronous `kernel.request(...)` path?

## immediate next steps

1. Implement `@gsv/package-worker` around this contract.
2. Implement static extraction of `definePackage(...)`.
3. Define the ripgit package analysis/build API around this spec.
4. Implement the real `PACKAGE.sql*` path against Package DO state.
