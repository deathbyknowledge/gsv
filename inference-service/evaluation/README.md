# Managed inference evaluation

This suite exercises the candidate behind `gsv/default` with synthetic GSV
tool, continuation, instruction-control, safety, and long-context tasks. It uses
the production DeepSeek adapter but bypasses the production promotion gate. It
does not use account data, entitlements, customer prompts, or the managed
budget ledger.

Run it with a secret-injected environment variable; the CLI intentionally does
not accept credentials as arguments:

```bash
npm run evaluate:deepseek --workspace inference-service
```

`DEEPSEEK_API_KEY` must exist in the process environment. The default official
run performs three repetitions. `--repetitions` and `--timeout-ms` are available
for diagnostics.

The JSON report contains task IDs, assertion pass rates, aggregate token usage,
estimated cost, and latency. It contains neither fixture prompts nor model
outputs. A passing report is necessary but insufficient for promotion: at least
one fallback candidate and every human release-gate review must also pass. Add
only immutable report digests—not raw output or credentials—to the
source-controlled release gate.
