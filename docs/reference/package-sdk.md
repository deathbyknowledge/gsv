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

Import the manifest helper from `@humansandmachines/gsv/sdk`.

`meta.capabilities.kernel` is the package's syscall grant list. Declare only the
calls the backend or CLI entrypoints actually need. Use `repo.*` when a package
needs to inspect or edit ripgit repositories, and `pkg.*` only for package
lifecycle operations such as install, checkout, review, and public visibility.

Example:

```ts
capabilities: {
  kernel: ["repo.read", "repo.search", "fs.read"],
},
```

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
  - issue kernel requests
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

## Browser helpers

Import browser helpers from `@humansandmachines/gsv/sdk`.

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

`routeBase` is the mounted app-session route for the current app instance.
`rpcBase` is the platform app-socket endpoint under that session mount.
Package apps should treat it as opaque and use `connectBackend()` instead of
speaking the wire protocol directly. App session credentials are carried in
HttpOnly cookies and are not exposed to package JavaScript.

### `hasAppBoot()`

Returns `true` when the package boot payload is present.

### `connectBackend<T>()`

Connects to the package backend RPC surface and returns a stable proxy.

Behavior:

- opens the backend app-socket session on first use
- caches the backend proxy for reuse
- reconnects automatically on transport disconnect and retries the failed call
  once
- throws immediately when the package has no backend entrypoint

### `getBackend<T>()`

Alias for `connectBackend<T>()`.

### `onAppEvent(listener)`

Subscribes to app events emitted by the backend with `this.app.emit(...)` or
`this.app.emitTo(...)`. Events are delivered over the same app socket used by
backend RPC.

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

## Browser entry rules

- browser entrypoints must be JS/TS modules, not HTML
- package apps render into the fixed platform shell
- `browser.assets` is for stylesheets and other static assets
- JSX packages must declare `preact`

## Package state

`this.storage.sql` is package-scoped runtime storage surfaced by the platform.

Current behavior:

- the storage boundary is package-runtime scoped
- the API is async from package code
- bindings accept `string`, `number`, `boolean`, and `null`
- booleans are stored as numeric SQLite values
