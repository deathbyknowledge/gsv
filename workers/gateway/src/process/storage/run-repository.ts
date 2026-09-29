import type { ProcessStore } from "../store";
import { runStateSchema, type RunState } from "../run/state";

const CURRENT_RUN_KEY = "currentRun";

/**
 * Owns the single durable active-run record.
 *
 * The record is intentionally stored as one opaque value: callers always read
 * or replace the complete state, while multi-record transitions are wrapped by
 * the controller in the Durable Object storage transaction that owns them.
 */
export class ProcessRunRepository {
  constructor(private readonly store: ProcessStore) { }

  get active(): RunState | null {
    const raw = this.store.state.getValue(CURRENT_RUN_KEY);
    if (!raw) return null;
    const parsed = runStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  }

  set active(state: RunState | null) {
    if (!state) {
      this.store.state.deleteValue(CURRENT_RUN_KEY);
      return;
    }

    const previous = this.active;
    if (previous?.runId !== state.runId) {
      this.store.traces.startTraceSpan({
        id: `run:${state.runId}`,
        runId: state.runId,
        kind: "run",
        name: "Run",
        startedAt: Date.now(),
        reference: { kind: "run" },
      });
    }
    this.store.state.setValue(CURRENT_RUN_KEY, JSON.stringify(state));
  }

  mutate(
    runId: string,
    mutation: (run: RunState) => RunState,
  ): RunState | null {
    const current = this.active;
    if (!current || current.runId !== runId) return null;
    const updated = mutation(current);
    this.active = updated;
    return updated;
  }
}
