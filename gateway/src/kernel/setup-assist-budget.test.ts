import { describe, expect, it } from "vitest";
import {
  SetupAssistBudget,
  SetupAssistRateLimitError,
} from "./setup-assist-budget";

type UsageRow = {
  hourly_window_started_at: number;
  hourly_requests: number;
  daily_window_started_at: number;
  daily_requests: number;
};

function createSql(): SqlStorage {
  let row: UsageRow | undefined;
  return {
    exec: (query: string, ...values: unknown[]) => {
      if (query.includes("SELECT hourly_window_started_at")) {
        return { toArray: () => row ? [row] : [] };
      }
      if (query.includes("INSERT INTO setup_assist_usage")) {
        row = {
          hourly_window_started_at: values[0] as number,
          hourly_requests: values[1] as number,
          daily_window_started_at: values[2] as number,
          daily_requests: values[3] as number,
        };
        return { one: () => undefined };
      }
      throw new Error(`Unexpected SQL: ${query}`);
    },
  } as unknown as SqlStorage;
}

describe("setup assistance budget", () => {
  it("enforces both hourly and daily inference limits", () => {
    const budget = new SetupAssistBudget(createSql());
    const start = Date.UTC(2026, 0, 1);

    for (let index = 0; index < 20; index += 1) budget.consume(start);
    expect(() => budget.consume(start)).toThrow(SetupAssistRateLimitError);

    for (let index = 0; index < 20; index += 1) {
      budget.consume(start + 60 * 60 * 1000);
    }
    for (let index = 0; index < 10; index += 1) {
      budget.consume(start + 2 * 60 * 60 * 1000);
    }
    expect(() => budget.consume(start + 2 * 60 * 60 * 1000)).toThrow(
      SetupAssistRateLimitError,
    );

    expect(() => budget.consume(start + 24 * 60 * 60 * 1000)).not.toThrow();
  });
});
