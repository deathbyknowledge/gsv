# GSV PDS

An AT Protocol personal data server and repository host for GSV, built on the
Cloudflare developer stack.

This worker is meant to host signed ATProto repos for GSV accounts, publish and
validate GSV lexicons, expose standard PDS XRPC surfaces, and stream repo events
for other GSV instances. It is not a Bluesky AppView, labeler, moderation
service, relay, or crawler.

## Architecture

The runtime has three main pieces:

- **Worker entrypoint**: owns HTTP routing, XRPC dispatch, OAuth endpoints,
  DID documents, handle resolution, service auth, and admin/debug routes.
- **PdsDirectoryObject**: the global directory for accounts, sessions, OAuth
  state, invite/admin state, repo event sequencing, `listRepos`, `listHosts`,
  and firehose fanout.
- **RepoObject**: one durable object per repo. It owns the signed Merkle Search
  Tree repo state, records, repo blocks, blobs, CAR import/export, and sync
  reads for that repo.

Storage is intentionally split:

- Durable Object SQLite stores account indexes, repo metadata, MST nodes, repo
  blocks, record indexes, blob metadata, and the firehose event log.
- R2 stores blob bytes when a `BLOB_BUCKET` binding is configured.
- DO SQLite is used as a blob byte fallback when `BLOB_BUCKET` is absent, which
  keeps local development and small test deployments simple.

Normal ATProto clients should use `/xrpc/...`. The `/repos/:name/...` routes are
admin/development conveniences for seeding and direct inspection.

## Current Support

Implemented areas:

- `did:web` and `did:plc` accounts
- ATProto account creation, sessions, app passwords, password changes, account
  deletion/deactivation, and admin account operations
- OAuth public clients and private-key JWT confidential client auth
- P-256 repo signing keys and PLC operations
- signed MST repos, DAG-CBOR records, CIDs, commit objects, and CAR export/import
- record create/update/delete/applyWrites/get/list
- blob upload/get/list/missing lifecycle, including unreferenced blob cleanup
- sync endpoints including `getRepo`, `getCheckout`, `getBlocks`, `getRecord`,
  `getBlob`, `listRepos`, `listReposByCollection`, `listHosts`, and
  `subscribeRepos`
- firehose replay/cursors and oversized commit events with `#sync`
- dynamic lexicon publication/resolution and record validation from schema defs
- handle syntax validation and configured local handle domains/suffixes
- service auth tokens for inter-service calls

Deliberately not implemented here:

- label querying or label streaming
- moderation report intake
- relay/crawler crawl request endpoints
- temporary Bluesky signup, phone verification, and signup queue endpoints

Those are separate service responsibilities, not repo/account hosting.

## Requirements

- Rust stable with the `wasm32-unknown-unknown` target
- Node.js and npm
- `worker-build`
- `wrangler`
- a Cloudflare account with Durable Objects enabled

Install JavaScript dependencies with:

```sh
npm install
```

If your Rust toolchain is missing the wasm target:

```sh
rustup target add wasm32-unknown-unknown
```

## Configuration

`wrangler.toml` defines the worker name, Durable Object bindings, and non-secret
defaults:

```toml
[vars]
PDS_LEXICON_AUTHORITY_DIDS = "gsv.space=did:web:gsv-pds.stevej.workers.dev,agent.gsv.space=did:web:gsv-pds.stevej.workers.dev,package.gsv.space=did:web:gsv-pds.stevej.workers.dev"
PDS_ALLOWED_ACCOUNT_HANDLE_SUFFIXES = "gsv.dev"
PDS_FIREHOSE_REPLAY_LIMIT = "64"
```

Important environment values:

- `PDS_ADMIN_TOKEN`: required for admin routes and smoke setup.
- `PDS_JWT_SECRET`: optional but recommended; if absent, the admin token is used
  to sign sessions.
- `PDS_PLC_ROTATION_KEY_P256_HEX`: optional 32-byte P-256 private key hex used
  for PLC account creation and PLC smoke tests.
- `PDS_PLC_DIRECTORY_URL`: optional PLC directory override; defaults to
  `https://plc.directory`.
- `PDS_PLC_RECOVERY_DID_KEY` or `PDS_PLC_RECOVERY_DID_KEYS`: optional recovery
  keys advertised in recommended DID credentials.
- `PDS_LEXICON_AUTHORITY_DIDS`: comma-separated `authority=did` mappings used
  to resolve lexicon schemas.
- `PDS_LEXICONS_JSON`: optional inline lexicon JSON object or array.
- `PDS_ALLOWED_ACCOUNT_HANDLES`: comma-separated exact handles allowed for local
  account creation; `*` allows any syntactically valid handle.
- `PDS_ALLOWED_ACCOUNT_HANDLE_SUFFIXES`: comma-separated suffixes allowed for
  local account creation.
- `PDS_MAX_ACCOUNT_BLOB_BYTES`: optional per-account blob byte limit.
- `PDS_FIREHOSE_REPLAY_LIMIT`: optional replay window size for firehose events.

For production blob storage, add an R2 binding:

```toml
[[r2_buckets]]
binding = "BLOB_BUCKET"
bucket_name = "gsv-pds-blobs"
```

## Local Development

Create `.dev.vars` for local secrets:

```sh
PDS_ADMIN_TOKEN=dev-admin-token
PDS_JWT_SECRET=dev-jwt-secret
```

Run the worker locally:

```sh
npm run dev -- --port 8788
```

Seed a repo against the local worker:

```sh
PDS_BASE_URL=http://localhost:8788 \
PDS_ADMIN_TOKEN=dev-admin-token \
npm run seed:test-repo
```

Inspect a hosted repo with pdsls using the AT URI form:

```text
https://pdsls.dev/at://did:web:<worker-host>
https://pdsls.dev/at://did:plc:<account-did>
```

## Deploy

Set secrets locally or in the shell, then run the deploy script:

```sh
export PDS_ADMIN_TOKEN="$(openssl rand -hex 32)"
export PDS_BASE_URL="https://<worker-host>"

npm run deploy:test
```

`deploy:test` does the following:

1. loads `.dev.vars` when present
2. checks required non-secret `wrangler.toml` vars
3. runs `npm run audit:xrpc`
4. uploads `PDS_ADMIN_TOKEN` and, when present,
   `PDS_PLC_ROTATION_KEY_P256_HEX`
5. deploys with Wrangler
6. runs remote smoke tests when `PDS_BASE_URL` is set

`PDS_JWT_SECRET` is optional because the worker falls back to `PDS_ADMIN_TOKEN`
for signing sessions, but a separate signing secret is better for a real
deployment:

```sh
printf '%s\n' "$(openssl rand -hex 32)" | npx wrangler secret put PDS_JWT_SECRET
```

Set `PDS_PLC_ROTATION_KEY_P256_HEX` before deploy to enable the PLC, migration,
firehose, official client, and conformance smoke tests.

Set these to enable the confidential OAuth smoke:

```sh
export OAUTH_CONFIDENTIAL_CLIENT_ID="https://client.example.com/client.json"
export OAUTH_CONFIDENTIAL_CLIENT_PRIVATE_KEY_JWK="@private-client-key.jwk"
```

## Scripts

Common commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run Wrangler dev. |
| `npm run deploy` | Deploy only. |
| `npm run deploy:test` | Audit, deploy, and optionally run remote smokes. |
| `npm run build:worker` | Build the Worker WASM bundle. |
| `npm test` | Run Rust tests. |
| `npm run audit:xrpc` | Compare implemented/tested methods against current `@atproto/api` lexicons. |
| `npm run seed:test-repo` | Create or update a test repo and seed record. |
| `npm run smoke:account` | Account/session/record/blob smoke. |
| `npm run smoke:delete-account` | Account deletion smoke. |
| `npm run smoke:public` | Public unauthenticated read smoke. |
| `npm run smoke:oauth:client` | Public OAuth client smoke using the official client. |
| `npm run smoke:oauth:confidential` | Confidential OAuth private-key JWT smoke. |
| `npm run smoke:plc-account` | PLC account creation smoke. |
| `npm run smoke:migration` | Repo/account migration smoke. |
| `npm run smoke:firehose` | Live firehose event smoke. |
| `npm run smoke:firehose:cursor` | Firehose replay cursor smoke. |
| `npm run smoke:firehose:oversize` | Oversized firehose commit smoke. |
| `npm run smoke:space-gsv-lexicons` | Publish `space.gsv.*` Lexicons and prove strict validation. |
| `npm run smoke:client` | Broader official `@atproto/api` client smoke. |
| `npm run smoke:conformance` | XRPC response conformance smoke for implemented official methods. |

## XRPC Coverage

The source of truth is:

```sh
npm run audit:xrpc
```

Current audit shape:

- official `com.atproto.*` methods in the generated client: 86
- implemented official methods: 74
- smoke-tested implemented methods: 74
- intentionally unsupported methods: 12
- extra implemented method outside the current generated client:
  `com.atproto.server.changePassword`

Unsupported official methods:

- `com.atproto.label.queryLabels`
- `com.atproto.label.subscribeLabels`
- `com.atproto.moderation.createReport`
- `com.atproto.sync.notifyOfUpdate`
- `com.atproto.sync.requestCrawl`
- `com.atproto.temp.addReservedHandle`
- `com.atproto.temp.checkHandleAvailability`
- `com.atproto.temp.checkSignupQueue`
- `com.atproto.temp.dereferenceScope`
- `com.atproto.temp.fetchLabels`
- `com.atproto.temp.requestPhoneVerification`
- `com.atproto.temp.revokeAccountCredentials`

`smoke:conformance` exercises every implemented official method. The lexicon
resolution check uses raw JSON because the current `@atproto/api` generated
validator rejects the official `com.atproto.lexicon.schema` record reference in
that endpoint's own output.

## Handles And Identities

Account handles are not limited to the request host. On account creation and
handle updates, the worker accepts handles that:

- match the request host
- match `PDS_ALLOWED_ACCOUNT_HANDLES`
- match `PDS_ALLOWED_ACCOUNT_HANDLE_SUFFIXES`

All accepted handles still go through ATProto handle syntax validation.

For GSV-owned accounts, this worker can be the PDS and host the account repo
directly. For accounts hosted on another PDS, GSV records can still exist there
as long as that PDS accepts and preserves the relevant records and the GSV
lexicons can be resolved.

## Notes For Future Work

The remaining meaningful work is outside the core repo/PDS path:

- decide whether this deployment should operate any labeler/moderation service
- decide whether a separate relay/crawler should ingest from this worker's
  firehose
- wire real email delivery if password-reset or confirmation emails should be
  sent to users directly
- add production R2 bucket bindings where blob byte durability should not rely
  on DO SQLite fallback
