# 100-Device Incident Demo

This demo connects 100 isolated Docker containers to one GSV instance as real
device drivers. One agent must inventory the fleet, correlate an active checkout
incident, ignore plausible red herrings, make a surgical repair on the affected
cohort, restart checkout remotely, and prove it did not disturb healthy devices.
The default remains the recording-friendly 100-device scenario. The same harness
also supports an exact 1,000-device connection/load run.

The audience-facing state is deliberately simple:

- baseline: 100 devices online, 17 degraded, 83 healthy;
- outcome: 100 healthy, 17 recovered, 83 untouched;
- proof: an independent verifier checks exact configs, state, restart evidence,
  and recovery logs.

Generated workspaces, answer-key data, Docker build context, and raw device
tokens live under `scripts/demo-fleet/.generated/` and are ignored by git. The
answer key is never mounted into a device container.

See [RECORDING.md](./RECORDING.md) for the short recording sequence.

## Prerequisites

- Docker with a reachable daemon.
- Bash 4 or newer. On macOS, use a current Homebrew Bash.
- Node.js 20 or newer.
- A current GSV CLI, or `DEMO_FLEET_GSV_BIN` pointing at one.
- A dedicated demo GSV user on a dedicated deployment instance.
- `GSV_USER_TOKEN` for that user. The bulk credential lifecycle deliberately
  does not read the CLI credential cache.

The fleet scripts reject password-on-command-line authentication. Do not set
`GSV_PASSWORD` for token creation or revocation.

## Deploy Current Main Safely

Do not rename only `gateway/wrangler.jsonc`: that leaves storage and service
bindings shared with the default instance. Current main supports named
deployments and rewrites the gateway, ripgit, assembler, bindings, and R2 bucket
as one isolated instance.

Build local bundles from this checkout:

```bash
npm run release:build:cloudflare -- ./release/local
```

For the existing demo instance, deploy those local bundles with the current CLI:

```bash
cd cli
cargo run -- infra upgrade \
  --version dev \
  --instance gsv-demo \
  --bundle-dir ../release/local \
  --force-fetch \
  --component ripgit \
  --component assembler \
  --component gateway
cd ..
```

Use `infra deploy` instead of `infra upgrade` for a brand-new instance. The
command prints the gateway URL when it finishes.

Complete setup in that instance, create a dedicated demo user/agent, and select
the model you want to record. For a smooth run, temporarily change that agent's
tool approval override for **Run shell commands / All machines** to **Allow**.
The normal `Ask` policy is target-specific and otherwise pauses once per device.
Restore the normal approval policy after recording.

## Seed and Issue Device Tokens

Set connection details without printing credentials in the recording terminal:

```bash
export GSV_URL="wss://your-demo-gateway.example/ws"
export GSV_USER="demo"
export DEMO_FLEET_GSV_BIN="$PWD/cli/target/debug/gsv"
```

Seed workspaces, provide the short-lived user credential without printing it,
then issue one device-bound token per target:

```bash
node scripts/demo-fleet/seed-fleet.mjs
: "${GSV_USER_TOKEN:?export a short-lived user token first}"
scripts/demo-fleet/create-device-tokens.sh
```

Tokens expire after 12 hours by default. Use `--ttl-hours N` (maximum 168) to
change that. Existing tokens must be rotated explicitly:

```bash
scripts/demo-fleet/create-device-tokens.sh --force
```

Rotation revokes the previous token IDs, and a partial creation failure rolls
back newly issued IDs.

## Prepare the Recording

This is the normal one-command preflight:

```bash
scripts/demo-fleet/prepare-fleet.sh --build
```

It:

1. removes only owned or positively identified legacy demo containers;
2. reseeds a fresh incident relative to the current time;
3. proves the exact 17-degraded / 83-healthy baseline;
4. builds the device image from this checkout and labels it with the source SHA;
5. starts the fleet with bounded resources; and
6. waits until all 100 clients remain connected across three consecutive checks.

Omit `--build` on later takes when the CLI source has not changed. A final
readiness check is available separately:

```bash
scripts/demo-fleet/status.sh --check
```

Use `--verbose` only for diagnostics; the default status stays compact enough
for a recording.

## Run the Exact 1,000-Device Scale Test

The scale mode keeps the canonical default IDs (`edge-001` through `edge-100`)
and extends them through `edge-999` and `edge-1000`. It intentionally keeps the
same 17-device incident cohort; the load-test question is simultaneous
connections, not a larger failure percentage.

Seed and issue all credentials before starting the ramp:

```bash
export DEMO_FLEET_DEVICE_COUNT=1000
export DEMO_FLEET_START_LIMIT=25
export DEMO_FLEET_WAIT_TIMEOUT=600
export DEMO_FLEET_START_PARALLELISM=10
export DEMO_FLEET_START_BATCH_DELAY_SECONDS=1
export DEMO_FLEET_MEMORY=64m
export DEMO_FLEET_CPUS=0.10

node scripts/demo-fleet/seed-fleet.mjs --devices 1000
scripts/demo-fleet/create-device-tokens.sh
scripts/demo-fleet/prepare-fleet.sh --build
```

Then add only the missing suffix at each stage. `--resume` (also accepted as
`--scale-up`) requires every retained container to be running and to match the
fleet, device, and image labels. It never replaces an earlier stage. If a new
stage fails, only containers carrying that stage's unique run label are removed.

```bash
for limit in 100 250 500 750 1000; do
  export DEMO_FLEET_START_LIMIT="$limit"
  scripts/demo-fleet/start-fleet.sh --resume
  scripts/demo-fleet/status.sh --check
done
```

At the final plateau, leave the fleet connected for at least five minutes and
run one more `status.sh --check`. The device keepalive interval is four minutes,
so an immediate 1,000/1,000 result proves admission but not a complete heartbeat
cycle.

Startup defaults to waves of 25 with a one-second gap; connection log checks
run with at most 50 concurrent Docker calls. Tune these only after measuring the
host and gateway with `DEMO_FLEET_START_PARALLELISM`,
`DEMO_FLEET_START_BATCH_DELAY_SECONDS`, and
`DEMO_FLEET_CHECK_PARALLELISM`. Scaling down is deliberately rejected; stop the
fleet first. Use [demo-prompt-1000.md](./demo-prompt-1000.md) for the agent run.

At 1,000 devices the monitor uses 50 cells per row (20 rows), grouped by tens:

```bash
node scripts/demo-fleet/monitor-fleet.mjs --watch
```

## Run the Demo

Start the host-side visual monitor in a second terminal:

```bash
node scripts/demo-fleet/monitor-fleet.mjs --watch
```

Then paste [demo-prompt.md](./demo-prompt.md) into a fresh GSV chat. The prompt
identifies the 100 target names and tells the agent that each workspace is
self-documenting, but it does not reveal the affected cohort or root cause.

The monitor reads only host-side simulation state. It is independent of the
agent and should be revealed after the agent has announced its diagnosis if you
do not want the audience to see affected positions early.

## Verify the Result

After the agent reports completion:

```bash
node scripts/demo-fleet/verify-fleet.mjs --expect repaired
```

The strict proof requires:

- every affected config equals its original plus exactly the two intended fixes;
- all affected devices are healthy after a post-seed checkout restart;
- health, metrics, service state, and matching recovery logs are coherent; and
- every unaffected device retains its exact seeded config and service state.

Extra changes that the old verifier tolerated now fail.

## Reset and Cleanup

Reset to a stopped, verified baseline:

```bash
scripts/demo-fleet/reset-fleet.sh
```

Reset and reconnect immediately:

```bash
scripts/demo-fleet/reset-fleet.sh --restart
```

For another recording, `prepare-fleet.sh` remains the clearest path. When the
demo is finished, remove the containers and revoke every device credential:

```bash
scripts/demo-fleet/revoke-device-tokens.sh --stop
```

Raw tokens are necessarily supplied to Docker at startup and remain visible to
local Docker administrators in container metadata until containers are removed.
Use only the dedicated instance, keep the TTL short, and run the revocation
step after recording.

## Validation

The verifier/domain tests do not require Docker or a gateway:

```bash
node --test scripts/demo-fleet/fleet-state.test.mjs
```

Syntax-check the harness and test both the fleet model and bulk token lifecycle:

```bash
node --check scripts/demo-fleet/seed-fleet.mjs
node --check scripts/demo-fleet/verify-fleet.mjs
node --check scripts/demo-fleet/monitor-fleet.mjs
bash -n scripts/demo-fleet/*.sh
node --test scripts/demo-fleet/bulk-device-tokens.test.mjs
```

## Useful Overrides

```bash
DEMO_FLEET_DEVICE_COUNT=10
DEMO_FLEET_START_LIMIT=10
DEMO_FLEET_IMAGE=gsv-demo-device:local
DEMO_FLEET_CONTAINER_PREFIX=gsv-demo
DEMO_FLEET_ID=recording
DEMO_FLEET_DIR=/tmp/gsv-demo-fleet
DEMO_FLEET_TOKENS_FILE=/tmp/gsv-demo-tokens.csv
DEMO_FLEET_NOW=2026-07-15T10:00:00Z
DEMO_FLEET_WAIT_TIMEOUT=180
DEMO_FLEET_STABLE_SAMPLES=3
DEMO_FLEET_START_PARALLELISM=25
DEMO_FLEET_START_BATCH_DELAY_SECONDS=1
DEMO_FLEET_CHECK_PARALLELISM=50
DEMO_FLEET_REMOVE_PARALLELISM=25
DEMO_FLEET_TOKEN_CONCURRENCY=16
DEMO_FLEET_TOKEN_PACE_MS=0
DEMO_FLEET_MEMORY=128m
DEMO_FLEET_CPUS=0.25
```

Partial fleets keep the same deterministic cohorts truncated to the requested
device count, which makes 10-device rehearsals useful before the default run.
The supported range is 1 through exactly 1,000 devices.
