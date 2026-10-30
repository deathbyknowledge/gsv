# Onboarding first-turn bench

Measures a new Ship's first turn: setup with a chosen language, welcome card
dismissed, first run captured. It uses the real gateway under workerd, the real
ripgit worker, the real prompts, and the production model through a recording
proxy. Nothing here is imported by production code.

## What is real and what is not

| Real | Stand-in |
| --- | --- |
| Gateway Worker, Kernel and Process Durable Objects, schemas, setup flow | Accounts directory and adapters: the integration fixtures |
| Production prompts and tools as they are in this worktree | `gsv/default` service: `funded-inference.ts`, the same pi-ai transport and compat flags as the managed service, without admission or accounting |
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` on Together, `reasoning_effort` from `config/ai/reasoning` | Web search binding absent, so no Search tool (about 300 tokens) |
| ripgit (Wasm build copied into `workers/ripgit/build`) | Cloudflare's network and storage: everything runs on one machine |

Because of the last row, the harness reproduces **model behaviour and token
counts** faithfully but not **platform latency**. Step 0 input was 9,844 tokens
here and 9,951 in production telemetry; the step-1 jump to about 17,800 tokens
matches too. Time between steps is 54 ms here and 2,755 ms in production.

## Setup

```bash
mise exec node@24 -- npm ci
cp -r ../gsv-phone-calls/workers/ripgit/build workers/ripgit/build   # or build it
mise exec node@24 -- npm run build --workspace web
```

`npm ci` at the repo root is enough: `workers/ripgit`'s own install (the step
that fails on `sharp` under Node 26) is only needed for ripgit's tests.

The provider key is read from `/home/someone/HAM/infrastructure/.env` by the
proxy, which is the only process that holds it. Spend is appended to
`runs/spend.jsonl` and the runner stops at $20.

## Running

```bash
bash bench/onboarding/run.sh --label baseline --langs en,es,de --runs 8
node bench/onboarding/report.mjs baseline
node bench/onboarding/why.mjs baseline 300             # reasoning, calls, failures per step
node bench/onboarding/ripgit-timeline.mjs <run.json>   # ripgit and syscalls against model steps
```

Options: `--reasoning off|minimal|low|...` pins the Ship before the wake,
`--ripgit-latency N` adds N ms per ripgit call, `--reply "text"` sends a second
message and records that turn, `--dump-requests` saves exact request bodies.

## Variants

`variants/*.patch` hold each iteration's source change. v1 to v5 apply
cumulatively in the order of their numbers, and v3 is v1 plus v2. v8 and v9 are
each a complete diff from a clean tree. They are experiments, not reviewed
changes; this branch keeps production source clean. Apply one with `git apply`,
then run `npm run gsv:build`, because some change the protocol package.

`check-variant.sh` runs the existing gateway tests nearest these changes.
`--reply auto` sends a fixed self-introduction in the run's language. The Ship's
account is always `rosa`, so only the Spanish reply's name matches it.
