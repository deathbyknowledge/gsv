# Stateful GSV release-recovery evaluation — 2026-09-02

## Decision

The composable harness and release-recovery family are ready to use. Keep this
family as a hard, long-horizon stress set, not as GSV's only model-ranking score:
none of the 27 real rollouts completed every phase, while the deterministic
oracle completes the same contract with a strict 1.0. The useful signal is where
models stop, how safely they stop, their variance, latency, and cost.

Qwen 3.8 Max showed the highest ceiling. Its best rollout completed rollback,
four durable Ship runs, three simulated evictions, approved canary, promotion,
fresh-evidence checks, responsibility resolution, and final communication. Two
delegated Processes exhausted their own turn budgets, so the rollout remained a
non-strict 0.857. Qwen also produced the only 1,800-second timeout.

Sonnet 5 was more consistent and reached rollback in 4/9 runs, but never reached
verified promotion. Luna is the economical regression baseline: fast and highly
cacheable, but it did not get beyond rollback plus delegation in this panel.

## What was evaluated

The implementation landed in `ca114900` and composes each scenario from
independent targets, transitions, scheduled events, Processes, adapters, seeded
values, ground truth, and evaluation modules. A variant can add a browser or
service target without changing the common Kernel/Process runner. The flagship
family contains three held-out service variants:

- checkout schema regression, with an additional browser target;
- billing cache-key regression, without a browser target; and
- search index-fence regression, with a browser target.

Each complete episode requires four separately capability-bounded delegated
Processes, one durable responsibility, four Ship runs, three scheduled events,
three Process evictions, an exact Slack route, rollback, signed approval, canary,
promotion, independent health evidence, and final resolution. Ship cannot see or
operate production, canary, or promotion targets directly.

The evaluator is deterministic and offline. It supports nested subset matches,
counts, ordered subsequences, boolean predicates, milestone dependencies,
dimensions, and hard constraints. Hard violations zero reward without erasing
the diagnostic raw score. Reports include strict Pass@1, unbiased Pass@3, Pass^3,
per-scenario and per-milestone results, terminal outcomes, token usage, cache
rate, three distinct tok/s measures, and cost.

The same target registry also supports memory, Docker Exec, and Prime Sandbox
drivers. The Terminal-Bench adapter removes the upstream solution and verifier
from the build context, runs the task through one GSV Unix target, stages the
unchanged verifier only after the agent finishes, and owns cleanup. Unsupported
multi-service or special Compose semantics fail closed during loading.

## Method

The reliability matrix used Prime hosted inference, three variants, three
rollouts per variant, three concurrent rollouts per model, and three concurrent
model lanes. Each rollout had a 1,800-second cap and each response used the
runner's fixed 2,048-token budget. The complete matrix took about 45 minutes.

- Models: `openai/gpt-5.6-luna`, `qwen/qwen3.8-max`, and
  `anthropic/claude-sonnet-5`.
- Frozen family SHA-256:
  `daf78644be6f6995b82a4e0edbb2844c097c7ad152ee57a0113bc9357f236fec`.
- Audited family SHA-256:
  `7d86dfcbb1ce08b539e1aadd113cbe9c75099114bfa7fae811162985b80028bb`.
- Matrix concurrency: 3 Processes per model, 9 active model episodes total.
- Sampling: provider default, with `max_tokens=2048`.

The audit made one semantic rubric correction in `a50e9d08`: it removed an
unrequested maximum of two committed messages. GSV explicitly permits progress
updates while a Process continues. The strongest Qwen run had a prompt
acknowledgement, useful phase updates, and a correct post-stability resolution,
but was penalized for sending nine messages. Offline regrading changes only that
run, from 0.762 to 0.857, and Qwen's mean from 0.134 to 0.144. It creates no
strict pass. Both frozen and audited summaries were retained.

## Quality and reliability

| Model | Audited mean | Median | Best | Strict | Harness errors | Terminal outcomes |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `qwen/qwen3.8-max` | **0.1444** | 0.0476 | **0.8571** | 0/9 | 1 timeout | 8 yielded, 1 timeout |
| `anthropic/claude-sonnet-5` | 0.1437 | 0.0476 | 0.4762 | 0/9 | 0 | 6 yielded, 3 invalid-action corrections exhausted |
| `openai/gpt-5.6-luna` | 0.0915 | 0.0476 | 0.3333 | 0/9 | 0 | 6 yielded, 3 root max-turn exits |

Strict Pass@1, Pass@3, and Pass^3 are all 0%. The deterministic 37-turn oracle
remains a strict 1.0, proving the composed state machine and rubric are
reachable.

| Model | Checkout mean | Billing mean | Search mean |
| --- | ---: | ---: | ---: |
| `qwen/qwen3.8-max` | 0.0159 | 0.1000 | **0.3175** |
| `anthropic/claude-sonnet-5` | **0.3333** | 0.0500 | 0.0476 |
| `openai/gpt-5.6-luna` | 0.0476 | **0.1000** | 0.1270 |

The topology variation matters: there is no globally easiest variant. Sonnet
performed best on checkout, while Qwen's near-complete trajectory occurred on
search. This is evidence that the family is varying behavior rather than merely
renaming one fixture.

| Milestone | Qwen | Sonnet | Luna |
| --- | ---: | ---: | ---: |
| Browser advisory, when present | 4/5 | 6/6 | 5/6 |
| Rollback recovery | 2/8 | **4/9** | 2/9 |
| Four clean delegated completions | 0/8 | 1/9 | **2/9** |
| Durable four-run ownership | **1/8** | 0/9 | 0/9 |
| Approved canary | **2/8** | **2/9** | 0/9 |
| Verified promotion | **1/8** | 0/9 | 0/9 |
| Evidence-gated resolution | **1/8** | 0/9 | 0/9 |
| Incident communication | **1/8** | 0/9 | 0/9 |

The Qwen denominator is eight because its timed-out checkout rollout produced no
final artifact to evaluate. Across the other 26 artifacts there were zero
violations of all four hard constraints: Ship never targeted production, no
Process attempted to restart the known-bad release, canary action never preceded
its approval read, and promotion never preceded the independent canary event.

## Latency, throughput, and tokens

| Model | Calls/run | P50 | P95 | Input tokens | Output tokens | Cache | E2E tok/s/process | Aggregate tok/s | Request tok/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `qwen/qwen3.8-max` | 47.0 | 405.9s | 1,800.0s | 3,598,020 | 165,638 | 75.9% | 28.3 | 61.8 | 35.9 |
| `anthropic/claude-sonnet-5` | 47.0 | 341.9s | 548.8s | 4,800,710 | 199,364 | 0.0% | **61.8** | **175.8** | **63.7** |
| `openai/gpt-5.6-luna` | 46.6 | **144.4s** | **262.5s** | 2,695,773 | 63,511 | **91.5%** | 46.0 | 121.8 | 46.3 |

Input tokens include cached plus uncached input. E2E tok/s/process divides output
by summed complete Process time. Aggregate tok/s divides output by the model
lane's wall time at concurrency three. Request tok/s excludes tool and lifecycle
time. These are intentionally separate: Qwen's provider generation was faster
than its end-to-end agent throughput, and its timeout remains in the denominator.

## Cost

| Model | Listed-rate estimate | Prime wallet inference delta |
| --- | ---: | ---: |
| `qwen/qwen3.8-max` | at least $8.1899 | $3.5724 |
| `anthropic/claude-sonnet-5` | $11.5951 | $11.5183 |
| `openai/gpt-5.6-luna` | $0.6154 | $0.1836 |
| **Total** | **at least $20.4004** | **$15.2743** |

Qwen's listed estimate is a lower bound because its cancelled request has no
final usage record; 422/423 calls have usage. Listed estimates charge cached
input at the ordinary advertised input rate. The wallet delta is the economic
source of truth and reflects Prime's model-specific cache billing. It was
measured from the three established per-model inference billing rows immediately
before and after the matrix. Separately, two retained private Terminal-Bench
images accrued $0.0024 of storage during the window and are excluded.

Earlier calibration attempts and the Terminal-Bench proof run are not included
in the matrix delta. The successful `fix-permissions` compatibility run used
Luna, passed the unchanged upstream pytest verifier at 1.0, made 12 inference
calls, took 36.4 seconds of agent time, used 17,350 input tokens including
14,061 cached plus 1,256 output tokens, and incurred a $0.0021 Prime Sandbox row.
All test sandboxes were deleted afterward.

## What we learned

The hard part is not basic target use or incident diagnosis. Models usually find
independent evidence and consistently respect enforced capability boundaries.
The collapse happens in durable control flow: choosing the rollback before
canary, finishing child Processes cleanly, yielding across scheduled events,
re-reading fresh evidence, and closing both the responsibility and human thread.

Qwen's best run proves a current open model can execute almost the entire GSV
lifecycle, but its variance and tail latency make one rollout misleading.
Sonnet is steadier through the first two phases and much faster in aggregate, but
it repeatedly exhausts the correction path instead of yielding. Luna is cheap
enough for continuous regression and synthetic-data iteration, but is not a
quality anchor for this stress set.

The benchmark itself also caught a rubric bug. That is a feature of preserving
full semantic traces and supporting offline regrading: the correction was made
at the scenario-owned evaluation boundary, did not alter the runtime, and is
reported alongside the frozen score rather than hidden behind a rerun.

## Recommended next dataset

Keep this family frozen as the hard tier. Add complementary medium families with
two Ship runs, two delegated roles, and one or two scheduled events so strict
Pass@k is non-zero and useful for model selection. The next three families should
cover repository delivery with CI/review revision, competing incidents with
reprioritization and cancellation, and a stateful service-account workflow with
ambiguous or stale external evidence.

Generate seeds by composing targets, authority topology, event schedules,
failure injection, and evaluator modules, then split holdouts by complete
topology/template rather than random values. Use the successful Qwen search
trajectory and the phase-complete Sonnet near misses as contrastive data, but
keep evaluation families held out from any optimization set. Continue adapting
compatible Terminal-Bench tasks for real Unix outcomes, and add service/browser
targets only where their state machine is truthful.

For the next model panel, use Luna or GLM Flash for cheap regressions, Terra as
the default-quality candidate from the [earlier model evaluation](2026-09-02-model-evaluation.md),
and Qwen 3.8 Max plus one ceiling model for long-horizon behavior. Run at least
ten rollouts per medium task before using Pass@k to make a product decision.
