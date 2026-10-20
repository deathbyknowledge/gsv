import { describe, expect, it } from "vitest";
import { matchOptionsForRule } from "./agentToolApprovalOptions";

describe("agent tool approval options", () => {
  it("offers an explicit outbound mail approval override", () => {
    expect(matchOptionsForRule("")).toContainEqual({ value: "mail.send", label: "Send mail" });
  });
});
