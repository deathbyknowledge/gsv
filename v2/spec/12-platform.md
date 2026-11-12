# 12 · Platform

How a deployment is described, what the runtime needs underneath it, how it
runs self-hosted, and how releases roll out while two versions run.

## What the core uses

Only what workerd runs: Workers, SQLite Durable Objects, alarms, hibernating
WebSockets, the Worker Loader, fetch, and a blob store. No D1, KV, Queues,
Workflows or Analytics Engine in the core. The directory (hostnames, handles,
signup) is part of the runtime; the operator's commercial policy (plans) stays
a binding `[D 11-11]`. It is one DO, off the signed-in path (see
[01](01-topology.md)). KV was considered as a read copy and rejected: it can't
hold claims, so it would only add a second copy `[D 11-12]`.

### Blobs

One small interface with two backends, R2 by binding and S3 over fetch, and
one contract suite run against both `[D 11-11]`:

```ts
interface BlobStore {
  put(key: string, body: ReadableStream | ArrayBuffer, opts?: { sha256?: string }): Promise<void>;
  get(key: string, range?: { offset: number; length?: number }): Promise<ReadableStream | null>;
  head(key: string): Promise<{ size: number; sha256?: string } | null>;
  delete(keys: string[]): Promise<void>;
  list(prefix: string, cursor?: string): Promise<{ keys: string[]; cursor?: string }>;
  multipart(key: string): Promise<{ id: string; part(n: number, body: ReadableStream): Promise<{ etag: string }>; complete(parts: { n: number; etag: string }[]): Promise<void>; abort(): Promise<void> }>;
}
```

32 MiB parts fit both backends `[D 11-11]`.

## `gsv.config.ts`

One typed file describes a deployment. It emits the Cloudflare config (Alchemy
consumes the same object) and the workerd config, with one compatibility date;
DO classes are generated from the code `[D 11-11]`. Its surface `[D 11-12]`:

| Key | What it is |
| --- | --- |
| `profile` | The person profile every person owner gets (Ship) |
| `ui` | Path to the web UI's built assets; every deployment serves one |
| `brand` | Only what the runtime itself writes: mail sender and footer, messenger and notification wording through `{product}` and `{agent}`, the agent's default name |
| `signup` | `open` or `closed` |
| `operatorSpace` | The space whose admins are the operators |
| `templates` | Signup templates: the plan a new space starts with |
| `services` | Which optional services are bound, or `none` |
| `plans` | The plan service binding, or none |
| `releaseBriefs` | Operator release briefs, opened as one responsibility per person owner (see [13](13-ship-profile.md)) |

```ts
// Exact syntax [NEW].
import { defineConfig } from "@gsv/runtime/config";
import ship from "../ship/profile";

export default defineConfig({
  release: "2.0.0",
  compatibilityDate: "2026-11-01",
  domain: "ship.space",
  profile: ship,
  ui: "../ship/web/dist",
  brand: { product: "Ship", agent: "Ship", mailFrom: "Ship" },
  signup: "open",
  operatorSpace: "ham",
  templates: { personal: { plan: "included" } },
  services: {
    inference: { worker: "gsv-inference" },
    mail: { worker: "gsv-mail" },
    messengers: { telegram: { worker: "gsv-telegram" }, whatsapp: "none" },
    cloud: "none",
    search: "none",
    telemetry: { otlp: "https://otlp.example/v1" },
  },
  plans: "none",
  releaseBriefs: [{ id: "2.0-welcome", brief: "./briefs/2.0-welcome.md" }],
});
```

- The UI talks to the runtime only through the client SDK. Ship's web UI is
  Ship's own, including its Ship-only screens; other deployments replace it or
  fork it. Desktop is Ship's app in 2.0 `[D 11-12]`.
- Ship gets no private hooks: everything it does goes through the profile, the
  config and the client SDK a developer would have. The runtime builds and
  passes its tests without Ship, using a small test profile, and a source check
  finds no Ship names in it `[D 11-12]`.
- The developer surface (profile, config, SDK) stays private after 2.0 until
  it is proven, then it may be published `[D 11-12]`.

## Signup and operators

`[D 11-12]`

- Signup is `open` or `closed`. Joining a household or company is membership,
  added by a space admin.
- Every deployment serves a UI. Signup and sign-in use the decided methods
  there; the CLI and Desktop sign in by a device code approved in it. There is
  no `gsv signup`.
- Operators are the admins of `operatorSpace`, signed in like anyone;
  dangerous operator actions ask for a fresh sign-in.
- A fresh deployment's first space comes from a one-time setup link printed by
  `gsv deploy`: single use, stored hashed, valid 24 hours.

## Optional services

Each has a `none` implementation that answers `unavailable` with a plain
message `[D 11-11]`:

| Service | Without the operator's service |
| --- | --- |
| Models | Own keys only |
| Web search | Own key, or off |
| Mail | SMTP out plus an inbound webhook, or off |
| Messengers | Own bot tokens (shared WhatsApp and phone numbers are operator-only) |
| Cloud computers and browsers | Off (own machines through gsvd) |
| Plans | No limits except per-run safety limits |
| Telemetry | Stays local |

## Self-hosting

One workerd process on one machine: local-disk DO SQLite, an S3-compatible
bucket, a TLS proxy or tunnel, scheduled SQLite backups. workerd's cluster mode
is watched, not promised; celld is not a 2.0 target `[D 11-11]`. Risk: workerd's
local-disk DO storage is experimental, so each release pins its workerd version;
the data stays plain SQLite files `[D 11-11]`.

## Two versions at once

`[D 11-11]`

- DO-to-DO and binding contracts are additive. Schemas expand, then contract.
- Migrations are versioned per DO class, forward-only, run at the object's
  first wake. The runner refuses code older than an object's recorded version.
- Stored records carry payload versions.
- A CI skew test runs N-1 against N both ways.
- Shipped migrations are never edited; the next number is added `[1.0]`.

## Updates and rollout

`[D 11-11]`

- Deferred code updates with a 300 s maximum delay. Every run survives a reset:
  open tool calls resolve by op id and are never replayed; open model calls are
  reissued. workerd restarts take the same path. `immediate` only for urgent
  fixes.
- Managed rollout is gradual: a small share of objects first, watching closed
  error codes and run failures, then everyone. Rollback to N-1 works because of
  the contract rules. New DO classes ship alone.
- Self-hosted upgrades go all at once after a backup; one release back is
  allowed.
- Release identity comes from the config, never a `dev` default. The runtime
  advertises client versions. Desktop and the extension get updaters; gsvd
  keeps 1.0's.

## Invariants

- **PLAT-1** The core bundle imports no Cloudflare-only API outside the blob and binding adapters.
- **PLAT-2** Every optional service call has a `none` path that returns `unavailable`.
- **PLAT-3** A DO never runs code older than its recorded schema version.
- **PLAT-4** A run survives a code update at any step.
- **PLAT-5** The runtime holds no Ship-specific names.

## Tests

- Blob contract suite against R2 (Miniflare) and an S3-compatible server (MinIO).
- The whole runtime suite on workerd with local-disk storage, with every service `none`.
- Skew: N-1 objects with N code and the reverse, for every DO class.
- Kill-at-every-step for runs during an update.
- Source check: no Ship names in `v2/runtime`.
