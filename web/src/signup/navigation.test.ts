import { describe, expect, it } from "vitest";
import { signupDestination } from "./navigation";

describe("browser signup handoff", () => {
  it("carries a friend's invitation alongside setup authorization without query credentials", () => {
    const destination = new URL(signupDestination("https://new.gsv.space", `onboard_${"x".repeat(43)}`, "contact-invitation"));
    const fragment = new URLSearchParams(destination.hash.slice(1));
    expect(destination.pathname).toBe("/onboarding");
    expect(destination.search).toBe("");
    expect(fragment.get("contact")).toBe("contact-invitation");
    expect(fragment.get("onboarding")).toBe(`onboard_${"x".repeat(43)}`);
  });
  it("carries setup authority only in the existing onboarding fragment", () => {
    const token = `onboard_${"x".repeat(43)}`;
    const destination = new URL(signupDestination("https://new.gsv.space", token));
    expect(destination.pathname).toBe("/onboarding");
    expect(destination.search).toBe("");
    expect(destination.hash).toBe(`#${token}`);
    expect(signupDestination("https://new.gsv.space", null)).toBe("https://new.gsv.space/");
  });

  it("supports a local Space during the complete signup flow", () => {
    expect(new URL(signupDestination("http://friend.localhost:8978", `onboard_${"x".repeat(43)}`)).origin)
      .toBe("http://friend.localhost:8978");
  });

  it.each(["javascript:alert(1)", "https://user:secret@gsv.space", "https://gsv.space/path", "https://gsv.space#token", "http://space.example", "http://localhost.example", "http://notlocalhost"])("rejects an invalid destination %s", (origin) => {
    expect(() => signupDestination(origin)).toThrow();
  });
});
