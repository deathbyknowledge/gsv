import { describe, expect, it } from "vitest";
import { replyFailureFromFinish } from "./finish";

describe("replyFailureFromFinish", () => {
  it.each([
    ["error", "generation.error", "generation"],
    ["error", "generation.empty", "generation"],
    ["error", "context.policy.fail", "context"],
    ["error", "media.timeout", "media"],
    ["error", "message.action.missing", "no_send"],
    ["error", "message.command.failed", "command"],
    ["error", "message.delivery.failed", "delivery"],
    ["error", "schedule.error", "runtime"],
    ["error", "tick.error", "runtime"],
    ["error", "recovery.schedule.error", "runtime"],
    ["error", "something.new", "other"],
    ["error", undefined, "other"],
    ["aborted", "user.superseded", "superseded"],
    ["aborted", "process.kill", "killed"],
    ["aborted", "user", "cancelled"],
    ["aborted", undefined, "cancelled"],
  ] as const)("maps %s/%s to %s", (status, reason, expected) => {
    expect(replyFailureFromFinish(status, reason)).toBe(expected);
  });
});
