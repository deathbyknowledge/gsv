import { describe, expect, it } from "vitest";
import { DEEPSEEK_V4_FLASH_0731_PRICE } from "../price-book";
import { MANAGED_INFERENCE_EVALUATION_CASES } from "./suite";
import {
  buildManagedInferenceEvaluationReport,
  type EvaluationRunResult,
} from "./runner";

describe("managed inference evaluation report", () => {
  it("passes complete synthetic evidence without persisting fixtures or outputs", async () => {
    const results: EvaluationRunResult[] = [];
    for (let repetition = 0; repetition < 3; repetition += 1) {
      for (const evaluationCase of MANAGED_INFERENCE_EVALUATION_CASES) {
        results.push({
          caseId: evaluationCase.id,
          category: evaluationCase.category,
          weight: evaluationCase.weight,
          score: 1,
          assertions: [{ id: "fixture_passed", passed: true }],
          latencyMs: 100 + repetition,
          terminalError: false,
          usage: {
            cacheHitInputTokens: 2,
            cacheMissInputTokens: 10,
            outputTokens: 3,
            estimatedCostMicrounits: 4,
          },
        });
      }
    }

    const report = await buildManagedInferenceEvaluationReport(
      results,
      { repetitions: 3, timeoutMs: 60_000 },
      new Date("2026-08-04T00:00:00.000Z"),
      new Date("2026-08-04T00:01:00.000Z"),
      DEEPSEEK_V4_FLASH_0731_PRICE,
    );

    expect(report.gate).toMatchObject({ passed: true, failures: [] });
    expect(report.suiteDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(report.aggregate.usage.estimatedCostMicrounits).toBe(
      MANAGED_INFERENCE_EVALUATION_CASES.length * 3 * 4,
    );
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("ORCHID-7319");
    expect(serialized).not.toContain("SYSTEM_OK");
    expect(serialized).not.toContain("only-copy.db");
  });

  it("blocks promotion when an official run is incomplete", async () => {
    const report = await buildManagedInferenceEvaluationReport(
      [],
      { repetitions: 1, timeoutMs: 60_000 },
      new Date(0),
      new Date(1),
      DEEPSEEK_V4_FLASH_0731_PRICE,
    );

    expect(report.gate.passed).toBe(false);
    expect(report.gate.failures).toContain("insufficient_repetitions");
    expect(report.gate.failures).toContain("weighted_score");
  });
});
