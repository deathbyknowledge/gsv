# Package SDK

## Manifest

```ts
type PackageDefinition = {
  meta: {
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
      daemon?: string[];
      storage?: string[];
    };
  };
  browser?: {
    entry: string;
    assets?: string[];
  };
  backend?: {
    entry: string;
    public_routes?: string[];
  };
  cli?: {
    commands?: Record<string, string>;
  };
};
```

Import package SDK helpers from `@humansandmachines/gsv/sdk`.

`meta.capabilities.kernel` is the package's syscall grant list. Declare only the
calls the browser, backend, or CLI entrypoints actually need. Use `repo.*` when
a package needs to inspect or edit ripgit repositories, and `pkg.*` only for
package lifecycle operations such as install, checkout, review, and public
visibility.

Example:

```ts
capabilities: {
  kernel: ["repo.read", "repo.search", "fs.read"],
  daemon: ["rpc-schedules"],
  storage: ["sql"],
},
```

`meta.capabilities.daemon` requests package daemon APIs such as RPC schedules.
`meta.capabilities.storage` requests package-scoped storage APIs such as SQL.

## Service Profiles

Packages can declare service-account profiles with files under
`profiles/<name>/`:

- `context.d/*.md` supplies the profile prompt/context and is required.
- `description.md` supplies human-readable review/UI text.
- `capabilities.json` optionally lists the profile agent's syscall grants.

When an enabled package has profiles, the gateway provisions one package-agent
account per profile and grants the enabling human run-as access. The run-as
reference uses `package-name#profile-name`; for example
`strudel-live#coproducer`. Package summaries expose each profile's
`account.runAs`, deterministic `account.username`, and, for installed packages,
`account.provisioned` plus `account.runnable`.

## Backend

Import the backend base class from `@humansandmachines/gsv/sdk`.

```ts
export default class ExampleBackend extends PackageBackendEntrypoint {
  async fetch(request: Request): Promise<Response> {
    return new Response("ok");
  }

  async onSignal(ctx: PackageSignalContext): Promise<void> {}
}
```

Backend instance bindings:

- `this.meta`
  - `{ packageName, packageId, routeBase }`
- `this.kernel.request(call, args)`
  - issue data-only kernel requests; rejects responses that carry a body
- `this.kernel.requestFrame(call, args, { body? })`
  - issue body-aware kernel requests and receive `{ data, body? }`
- `this.storage?.sql.exec(statement, ...bindings)`
  - execute package-scoped SQLite statements
- `this.viewer`
  - authenticated viewer identity for session-backed requests
- `this.app`
  - browser app session metadata
- `this.daemon`
  - RPC schedule helpers and current trigger metadata

Reserved built-ins:

- `fetch(request)`
  - optional HTTP route handler
- `onSignal(ctx)`
  - optional signal hook

Every other public method is exposed as backend RPC.

### Runtime authority and routing

An active browser session uses a generation-bound route handle. It binds the
owner's canonical username and uid, user-Kernel generation, expiry, nonce, and a
Master-issued P-256 placement certificate into a user-Kernel HMAC. The Gateway
verifies the certificate before it selects `user:<username>`; that Kernel then
verifies the HMAC, active marker, local session, package revision, artifact, and
entrypoint. The user Kernel resolves session metadata; admitted request and
response bodies flow between the Gateway and AppRunner rather than through
`singleton`.

A generation-less UUID is an explicit legacy compatibility form only. It is
accepted through `singleton` only while the account placement is still
`legacy`; current user-Kernel sessions never fall back to it.

Every AppRunner-owned HTTP, socket, RPC, command, signal, SQL, outbound, and
daemon path supplies its exact current control or data object name during
Kernel authorization. Migration v22 records that object only after successful
authorization, binding the package actor username/uid, controlling Kernel-owner
username/uid, and package id. The Kernel owner, run-as actor, and package
jointly determine the physical
`app-control-v3:<kernelOwnerUid>:<actorUid>:<encodedPackageId>` or
`app-data-v2:<kernelOwnerUid>:<actorUid>:<encodedPackageId>` name; the human
Kernel owner determines which user Kernel may exercise package/lifecycle fence
authority. A registry write failure denies the call, and the deterministic
object name alone grants nothing.

Package-authority and user-lifecycle transitions persist a gate in each observed
AppRunner, close admission and sockets, abort tracked cancelable request,
response, and outbound streams, delete alarms, and wait for tracked SQL,
command, signal, and daemon wrappers to release before the Kernel fence clears.
Preparing the fence first persists a monotonic, never-reused runtime epoch.
Loader RPC promises without a cancellation handle are abandoned when their
wrapper is aborted and remain observed; Loader keys, entrypoints, and every
package-to-platform call carry the exact epoch, so late work from the revoked
epoch cannot acquire current authority. Package code must not detach
authority-bearing work past the tracked call/stream lifetime and must not rely
on a late result being accepted after its authority revision changes.

## Browser Client

Import browser helpers from `@humansandmachines/gsv/sdk`.

### `createGsvClient()`

Creates a package-scoped GSV client. The SDK chooses the right transport for the
runtime: inside the GSV shell it uses the host bridge and shell-owned app
session, while standalone/dev contexts may use the direct app-session route.

```ts
import { bodyToText } from "@humansandmachines/gsv/protocol";

const gsv = await createGsvClient();

const response = await gsv.request("fs.read", { path: "/notes/today.md" });
const text = response.body ? await bodyToText(response.body) : "";
await gsv.fs.transfer.stat({ path: "/notes/today.md" });
```

Use `request()` for body-bearing syscalls such as `fs.read`, `net.fetch`, and
`proc.media.read`. Generated namespaces and `call()` are data-only, so those
syscalls are intentionally absent from them.

The gateway evaluates requests with the package app principal and the
manifest-declared `meta.capabilities.kernel` allowlist.

### `getGsvClient()`

Returns the same package-scoped client proxy without eagerly opening the app
session channel.

### `getAppBoot()`

Returns browser boot metadata:

```ts
type PackageAppBoot = {
  packageId: string;
  packageName: string;
  routeBase: string;
  rpcBase: string;
  sessionId: string;
  clientId: string;
  expiresAt: number;
  hasBackend: boolean;
};
```

### `hasAppBoot()`

Returns `true` when the package boot payload is present.

### `connectBackend<T>()`

Connects to the package backend RPC surface and returns a stable proxy.

Behavior:

- opens the app-session channel on first use
- caches the backend proxy for reuse
- reconnects automatically on transport disconnect and retries the failed call
  once
- throws immediately when the package has no backend entrypoint

### `getBackend<T>()`

Alias for `connectBackend<T>()`.

## CLI

Import CLI helpers from `@humansandmachines/gsv/sdk`.

```ts
type PackageCommandContext = {
  meta: {
    packageName: string;
    packageId: string;
    routeBase: string | null;
  };
  viewer: {
    uid: number;
    username: string;
  };
  kernel: {
    request<T = unknown>(call: string, args?: unknown): Promise<T>;
  };
  storage?: {
    sql: {
      exec<T extends Record<string, unknown>>(
        statement: string,
        ...bindings: Array<string | number | boolean | null>
      ): Promise<T[]>;
    };
  };
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

Use `defineCommand(handler)` and default-export the handler module.

Installed package commands are exposed in the native GSV shell by command name.
For example, a package manifest with `cli.commands.wiki` makes `wiki ...`
available through `shell.exec` on `target: "gsv"`, subject to the package's
declared kernel grants.

## Public routes

`backend.public_routes` is the only auth-bypass declaration in the manifest.

Rules:

- exact path matches only
- routing still lives in `backend.fetch()`
- undeclared backend paths remain session-authenticated
- package code is still responsible for webhook signature checks and any
  route-specific authorization
- routing binds an explicit owner and entrypoint; a request username is never
  used to search for a matching package runtime

## Browser entry rules

- browser entrypoints must be JS/TS modules, not HTML
- package apps render into the fixed platform shell
- `browser.assets` is for stylesheets and other static assets
- JSX packages must declare `preact`

## Package state

`this.storage.sql` is package-scoped runtime storage surfaced by the platform.

Current behavior:

- the storage boundary is the immutable controlling Kernel-owner uid/run-as
  actor uid/package tuple, physically named
  `app-data-v2:<kernelOwnerUid>:<actorUid>:<encodedPackageId>`
- package SQL runs in a data-only Durable Object physically separate from app
  sessions, daemon schedules, and schema migration control state
- the API is async from package code
- bindings accept `string`, `number`, `boolean`, and `null`
- booleans are stored as numeric SQLite values
- the current data object is registered only after exact Kernel authority
  succeeds and participates in package/lifecycle drains once observed

For upgrades from the pre-isolation and pre-owner-qualified AppRunner layouts,
the old `app:` and `app-data:` package SQL bytes remain preserved but
unavailable. The fresh `app-data-v2:` store is not a successful data migration;
continuity remains blocked on the documented explicit AppRunner package-data
migration.

## Ship source changes

After changing a package source tree under `/src/repos`:

```bash
rgit diff owner/repo
rgit commit owner/repo --message "update package"
pkg update <package> --ref main
```

Use `repo.import` or the console's **Pull upstream** action to fetch upstream
changes into a deployed `root/gsv`. The pull records
`refs/remotes/upstream/<ref>` and fast-forwards the local branch only when safe.
If local commits diverged, merge upstream first and then update affected
packages explicitly.

If you changed the package runtime, SDK, assembler, or Gateway code, redeploy
the relevant infrastructure before updating installed packages.

## See also

- [Applications](../how-to/applications)
- [Architecture Overview](../architecture/)
