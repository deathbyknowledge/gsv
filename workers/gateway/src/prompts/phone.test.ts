import { describe, expect, it } from "vitest";
import { renderPhoneInstructions } from "./phone";

const brief = { to: "+31600000000", onBehalfOf: "Steve", goal: "Ask Kawah what she thinks of Ship placing calls", ifOutsideLimits: "end" as const };

describe("phone instructions", () => {
  it("tells the agent when to check in with the owner and hold the line", () => {
    const rendered = renderPhoneInstructions({ ...brief, checkIn: "after she shares her thoughts, before ending the call" });
    expect(rendered).toContain("Check in with Steve: after she shares her thoughts, before ending the call. At that point use the ask tool");
    expect(rendered).toContain("keep the line until the answer arrives");
    expect(renderPhoneInstructions(brief)).not.toContain("Check in with");
  });
});
