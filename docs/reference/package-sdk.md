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

Import the manifest helper from `@gsv/package/manifest`.

## Backend

Import the backend base class from `@gsv/package/backend`.

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

Import browser helpers from `@gsv/package/browser`.

### `getAppBoot()`

Returns browser boot metadata:

```ts
type PackageAppBoot = {
  packageId: string;
  packageName: string;
  routeBase: string;
  rpcBase: string;
  sessionId: string;
  sessionSecret: string;
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

- opens the backend websocket session on first use
- caches the backend proxy for reuse
- reconnects automatically on transport disconnect and retries the failed call
  once
- throws immediately when the package has no backend entrypoint

### `getBackend<T>()`

Alias for `connectBackend<T>()`.

## CLI

Import CLI helpers from `@gsv/package/cli`.

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
