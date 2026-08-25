# Recording Runbook

The story is not “100 containers.” It is one GSV agent reasoning and acting
across 100 independent machines while changing only the machines that evidence
supports.

## Before Capture

1. Deploy the current checkout as the isolated `gsv-demo` instance.
2. Use a dedicated demo user and agent.
3. Temporarily allow that agent to run shell commands on all demo machines.
4. Run `scripts/demo-fleet/prepare-fleet.sh --build`.
5. Confirm `scripts/demo-fleet/status.sh --check` reports `100/100` connected.
6. Open a fresh chat and close unrelated windows, notifications, and terminals
   that could reveal credentials.
7. Start `node scripts/demo-fleet/monitor-fleet.mjs --watch` off-screen.

Never show `tokens.csv`, `docker inspect`, environment dumps, local auth files,
or credential-bearing git remote URLs in the recording.

## Suggested 75–90 Second Sequence

### 1. Establish scale — 8 seconds

Open **Machines** and hold on `100/100 ONLINE`. Search for `edge-100`, then open
one machine briefly so the filesystem and shell capabilities are visibly real.

### 2. Give one instruction — 8 seconds

Open a fresh Chat and paste `demo-prompt.md`. Keep Machines visible if the shell
layout allows it.

### 3. Show investigation — 15–20 seconds

Let the tool activity establish bounded fleet-wide inspection. Hold on the
agent's compact milestones:

- 100 inspected;
- a shared bad-rollout signature identified;
- healthy canaries, old auth errors, disk warnings, latency, and the intentional
  EU region excluded.

Avoid opening hundreds of individual tool rows. The scale should be legible,
not noisy.

### 4. Show controlled actuation — 15 seconds

Once the agent names the affected cohort, reveal the 10×10 monitor. The audience
should see 17 degraded cells move through recovery while healthy devices stay
stable. Time-compress this section if needed.

### 5. Hold on the report — 15 seconds

The final report should make these facts immediately readable:

- 100 inspected;
- 17 affected and 17 recovered;
- 83 untouched;
- shared root cause and exact two-field remediation;
- unrelated signals explicitly excluded.

### 6. End with independent proof — 10 seconds

Run:

```bash
node scripts/demo-fleet/verify-fleet.mjs --expect repaired
```

Hold on the PASS rows, then end back on Machines at `100/100 ONLINE` or on the
all-healthy monitor.

## After Capture

Restore the agent's normal shell approval policy, then remove containers and
revoke the short-lived device tokens:

```bash
scripts/demo-fleet/revoke-device-tokens.sh --stop
```
