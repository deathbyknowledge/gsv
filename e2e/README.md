# Disposable core end-to-end test

This package turns the high-value path in
[`manual-release-checklist.md`](./manual-release-checklist.md) into one manually
invoked test. It owns disposable deployment orchestration and verification; it
does not own CI, external adapters, or production infrastructure.

The test deploys only `ripgit`, `assembler`, and `gateway` under a unique
`gsv-e2e-*` namespace. It then exercises:

1. a real Cloudflare deployment built from the checked-out source;
2. fresh browser onboarding with an immutable bootstrap ref;
3. setup completion, desktop reload, lock, wrong-password rejection, and
   correct-password recovery;
4. isolated CLI login, version provenance, and `proc list`;
5. a foreground runner-local device and a deterministic custom AI provider
   reached through that device;
6. exact-text, device-targeted Shell, and durable delegation agent turns;
7. delayed-inference cancellation, transport disconnect, and stale-output
   suppression; and
8. strict Worker, Durable Object, and R2 teardown verification.

## One-time setup

Run the repository dependency setup first. Then install the independent e2e
package and its Chromium binary:

```bash
./scripts/setup-deps.sh
npm ci --prefix e2e
npm --prefix e2e exec -- playwright install chromium
```

Use a dedicated Cloudflare test account. Export its credentials in the calling
shell so they do not appear inline in the invocation or in the retained log:

```bash
export CF_API_TOKEN
export CF_ACCOUNT_ID
```

The API token must have the account permissions required by `gsv infra` to
create, inspect, and delete Workers, Durable Objects, and R2 buckets. The
harness refuses to start without both environment variables.

The checked-out commit must be reachable from a public Git remote. By default,
the harness converts the `origin` GitHub SSH URL to HTTPS and provisions system
files at `git rev-parse HEAD`. This avoids importing a moving branch during
onboarding.

## Run

The documented entry command is:

```bash
./e2e/run.sh
```

The working tree must be clean so the CLI, Worker bundles, lease provenance,
and onboarding bootstrap all identify the same source revision. For local
iteration, `--allow-dirty` makes the mismatch explicit; bootstrap still pins
`HEAD`.

Useful deliberate overrides:

```bash
./e2e/run.sh --headed
./e2e/run.sh --skip-build --bundle-dir ./release/local
./e2e/run.sh --bootstrap-source https://github.com/OWNER/REPO.git --bootstrap-ref IMMUTABLE_SHA
```

`--skip-build` reuses `cli/target/debug/gsv` and local bundles. Use it only when
those artifacts were built from the source you intend to test. Separate
`--skip-cli-build` and `--skip-bundle-build` flags are also available.

## Ownership and cleanup

Before deployment, `gsv infra status --all --json` must report the generated
namespace as `absent`; a partial or deployed namespace is treated as a
collision. The deploy command writes a schema-versioned, credential-free lease
manifest, which is validated against the exact instance, commit, three Worker
names, R2 bucket, and gateway URL before any test uses it.

An exit trap always stops the foreground device and mock provider first. It
then purges R2, destroys only the three Workers in the owned namespace, and
uses the CLI's strict `--verify` path to prove absence. Partial deploy failures
take the same cleanup path.

Resources are never kept by default. `--keep-on-failure` is an explicit escape
hatch for Cloudflare-side inspection; when used, a prominent exact cleanup
command is printed. Local credentials and child logs are still deleted. The
kept instance necessarily retains its generated test accounts and process state
until that cleanup command runs.

## Results and privacy

Sanitized results are written to `e2e/results/<run-id>/` by default:

- `lease.json`: resource identifiers and release provenance only;
- `checks.ndjson`: check names, statuses, and timestamps;
- `summary.json`: overall outcome and non-secret run metadata; and
- `run.log`: orchestration output without shell tracing or raw credentials.

Raw CLI token output, cached local sessions, and device/provider logs exist only
beneath a mode-`0700` temporary runtime directory and are removed on every exit.
Agent prompts, histories, and tool arguments live in the disposable instance and
disappear with normal teardown; `--keep-on-failure` retains that remote test
state until manual cleanup. Playwright screenshots, traces, and video are
disabled because setup-complete DOM can contain one-time credentials; any other
browser failure context is also directed to the temporary runtime.

## Current scope

This is the first deterministic core slice. It intentionally does not run
Telegram, Discord, WhatsApp, OAuth, real-model canaries, browser extensions,
large-body transfer, shell-process escalation, upgrade migrations, or CI
scheduling. The
manual checklist remains the scenario inventory for those later lanes.

All CLI lifecycle syntax is isolated in [`lib/lifecycle.sh`](./lib/lifecycle.sh)
so manifest or flag changes have one integration point.
