# Test Deploy

This repo has a small deployment and seed flow for checking a public Worker with
PDSls.

## Prerequisites

- Cloudflare auth configured for `wrangler`.
- A public route for the Worker. `wrangler.toml` currently has
  `workers_dev = false`, so either attach a route/custom domain or temporarily
  enable `workers_dev` for a throwaway test.
- A private admin token. Generate one with:

```bash
export PDS_ADMIN_TOKEN="$(openssl rand -hex 32)"
```

## Deploy

```bash
npm run deploy:test
```

The script stores `PDS_ADMIN_TOKEN` as a Worker secret, runs `wrangler deploy`,
and prints the seed command to run next.

If `PDS_PLC_ROTATION_KEY_P256_HEX` is set, the deploy script also stores it as a
Worker secret. This is only needed for did:plc account migration operations:
`com.atproto.identity.getRecommendedDidCredentials`,
`requestPlcOperationSignature`, `signPlcOperation`, and
`submitPlcOperation`.

## Seed And Check

```bash
export PDS_BASE_URL="https://<your-worker-host>"
export PDS_ADMIN_TOKEN="<same-token-used-for-deploy>"
npm run seed:test-repo
```

The seed script initializes a host-level `did:web:<host>` repo, writes one
`app.gsv.record` record, exercises `createRecord`/`putRecord`/`deleteRecord`,
checks write preconditions and `applyWrites`, uploads and reads one blob, checks
missing blob refs, verifies both well-known identity endpoints, checks the
PDS-level repo listing, checks `subscribeRepos` WebSocket replay, reads the
record back through XRPC, downloads full and `since`-bounded
`com.atproto.sync.getRepo` CARs, and prints PDSls links like:

```text
https://pdsls.dev/at://did:web:<your-worker-host>
https://pdsls.dev/at://did:web:<your-worker-host>/app.gsv.record/seed
```

By default, the script generates a new P-256 signing key and prints it as
`signingKeyP256Hex`. Keep that value only for disposable test repos, or pass
`PDS_SIGNING_KEY_P256_HEX` explicitly when you need deterministic re-seeding.

To exercise password-backed account sessions instead of the admin token write
path, run:

```bash
export PDS_ACCOUNT_PASSWORD="<test-password>"
npm run smoke:account
```

`createAccount` is admin-gated for now, so the smoke uses `PDS_ADMIN_TOKEN` for
initial account creation, then logs in with the password and writes a record with
the returned access token. Email is optional and not used by the smoke.

To exercise a full did:plc account creation and PLC update flow, configure a
persistent server rotation key first:

```bash
export PDS_PLC_ROTATION_KEY_P256_HEX="<64 hex chars>"
npm run deploy:test
PDS_BASE_URL="https://<your-worker-host>" \
PDS_ADMIN_TOKEN="<same-token-used-for-deploy>" \
npm run smoke:plc-account
```

The PLC smoke creates a real did:plc account, resolves its DID document, signs
and submits a PLC update operation, writes an account record, and prints a PDSls
link for the new did:plc repo.

Useful optional variables:

- `PDS_HANDLE`: handle to publish in the DID document, defaults to the base URL
  hostname.
- `PDS_DID`: repo DID, defaults to `did:web:<PDS_HANDLE>`.
- `PDS_REPO`: Durable Object name, defaults to the DID's local identifier.
- `PDS_RESET=false`: keep an existing initialized repo instead of resetting it.
- `PDS_RECORD_PATH`: record path, defaults to `app.gsv.record/seed`.
- `PDS_RECORD_JSON`: JSON object to store instead of the default seed record.
- `PDS_ACCOUNT_HANDLE`: account handle for `smoke:account`, defaults to the base
  URL hostname.
- `PDS_ACCOUNT_PASSWORD`: password for `smoke:account`, defaults to a local-only
  test value.
- `PDS_PLC_ROTATION_KEY_P256_HEX`: P-256 private key used to sign did:plc
  genesis and update operations. Without it, newly-created accounts default to
  did:web and PLC signing/submission returns 501.
- `PDS_PLC_RECOVERY_DID_KEY` or `PDS_PLC_RECOVERY_DID_KEYS`: optional did:key
  recovery keys to include before the server rotation key in recommended PLC
  credentials. Use comma-separated values for `PDS_PLC_RECOVERY_DID_KEYS`.
- `PDS_PLC_DIRECTORY_URL`: optional PLC directory base URL, defaults to
  `https://plc.directory`.
- `PDS_PLC_ACCOUNT_HANDLE`: optional handle for `smoke:plc-account`, defaults to
  a new `plc-<timestamp>.gsv.dev` handle.

## Local Smoke

```bash
npm run dev -- --port 8788
```

In another shell:

```bash
PDS_BASE_URL=http://localhost:8788 \
PDS_ADMIN_TOKEN=dev-admin-token \
PDS_SIGNING_KEY_P256_HEX=0000000000000000000000000000000000000000000000000000000000000001 \
npm run seed:test-repo
```

The local smoke expects `.dev.vars` to contain:

```text
PDS_ADMIN_TOKEN=dev-admin-token
```
