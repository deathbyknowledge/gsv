import { describe, expect, it } from "vitest";
import { collectNodes, collectText } from "../app/testing/testHarness";
import { DesktopAppLink } from "./DesktopAppLink";

describe("signup desktop app link", () => {
  it("points at the latest release page in a new tab without a referrer", () => {
    const tree = DesktopAppLink();
    const link = collectNodes(tree).find((node) => node.type === "a")!;
    expect(link.props.href).toBe("https://github.com/deathbyknowledge/gsv/releases/latest");
    expect(link.props).toMatchObject({ target: "_blank", rel: "noreferrer" });
    expect(collectText(link)).toBe("Try the beta desktop app");
    expect(collectText(tree)).toContain("Your invite code works there too");
  });
});
