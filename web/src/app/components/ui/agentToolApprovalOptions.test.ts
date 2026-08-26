import { describe, expect, it } from "vitest";
import { APPROVAL_MATCH_OPTIONS } from "./agentToolApprovalOptions";

describe("agent tool approval options", () => {
  it("offers an explicit outbound mail approval override", () => {
    expect(APPROVAL_MATCH_OPTIONS).toContainEqual({
      group: "Mail",
      label: "Send mail",
      value: "mail.send",
      description: "Send a new email or reply to an existing message.",
    });
  });
});
