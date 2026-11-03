import { describe, expect, it } from "vitest";
import { replyFailureFromFinish, type RunFinishReason } from "./finish";

describe("replyFailureFromFinish", () => {
  it.each([
    ["generation.error", "generation"],
    ["generation.empty", "generation"],
    ["context.checkpoint.failed", "context"],
    ["context.policy.fail", "context"],
    ["context.auto_compact.empty", "context"],
    ["context.auto_compact.failed", "context"],
    ["context.auto_compact.insufficient", "context"],
    ["context.provider_overflow", "context"],
    ["media.error", "media"],
    ["media.timeout", "media"],
    ["message.action.missing", "no_send"],
    ["message.command.failed", "command"],
    ["message.delivery.failed", "delivery"],
    ["schedule.error", "runtime"],
    ["tick.error", "runtime"],
    ["recovery.schedule.error", "runtime"],
    ["user.superseded", "superseded"],
    ["user", "cancelled"],
    ["process.reset", "cancelled"],
    ["process.kill", "killed"],
  ] as const satisfies ReadonlyArray<readonly [RunFinishReason, string]>)("maps %s to %s", (reason, expected) => {
    expect(replyFailureFromFinish(reason)).toBe(expected);
  });

  it.each(["run.yielded", "ipc.returned"] as const)("keeps a failed record valid if completion reason %s ever ends one", (reason) => {
    expect(replyFailureFromFinish(reason)).toBe("other");
  });
});
