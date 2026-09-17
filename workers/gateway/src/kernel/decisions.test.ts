import { beforeEach, describe, expect, it, vi } from "vitest";
import { testPeer } from "../test-support/peers";
import type { KernelContext } from "./context";
import * as execution from "../inference/decision-client";
import { handleAiDecide } from "./decisions";

const execute = vi.spyOn(execution, "executeDecision");
beforeEach(() => { execute.mockReset().mockResolvedValue({ provider: "typesafe", model: "jev-latest", answers: {}, usage: { inputTokens: 0, outputTokens: 0 } }); });
function context(config: Record<string, string> = {}): KernelContext {
  // SAFETY: This fixture supplies only the principal, ownership and configuration boundary used here.
  return {
    installationId: "space-a", requestId: "request-a", processId: "process-a", processRunId: "run-a",
    peer: testPeer({ kind: "human", calls: ["ai.decide"], account: { uid: 2000, gid: 2000, gids: [100], username: "agent", home: "/home/agent", cwd: "/home/agent" } }),
    procs: { getOwnerUid: () => 1000 }, env: {},
    config: { get: (key: string) => config[key] ?? null, getExplicit: (key: string) => config[key] ?? null },
  } as unknown as KernelContext;
}
const args = { state: "context", questions: { keep: { type: "boolean" as const, instructions: "Retain?" } } };

describe("decision credentials", () => {
  it("uses the process owner's credential and preserves the acting account", async () => {
    await handleAiDecide(args, context({ "users/1000/ai/decision/api_key": "owner-test-key", "config/ai/decision/api_key": "system-test-key" }));
    expect(execute.mock.calls[0][1]).toMatchObject({ installationId: "space-a", actor: { localUid: 2000, processId: "process-a", runId: "run-a" }, connection: { apiKey: "owner-test-key", useOperatorKey: false } });
  });
  it("does not mix a partial personal configuration with operator credentials", async () => {
    await handleAiDecide(args, context({ "users/1000/ai/decision/model": "jev-latest", "config/ai/decision/api_key": "system-test-key" }));
    expect(execute.mock.calls[0][1].connection).toMatchObject({ apiKey: "", useOperatorKey: false });
  });
  it("allows the executor's operator secret only without a personal override", async () => {
    await handleAiDecide(args, context());
    expect(execute.mock.calls[0][1].connection).toMatchObject({ apiKey: "", useOperatorKey: true });
  });
  it("rejects an unbounded deadline before acquiring an executor", async () => {
    await expect(handleAiDecide({ ...args, timeoutMs: Infinity }, context())).rejects.toThrow("timeout");
    expect(execute).not.toHaveBeenCalled();
  });
});
