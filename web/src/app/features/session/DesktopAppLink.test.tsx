import { describe, expect, it } from "vitest";
import { collectNodes, collectText } from "../../testing/testHarness";
import { DesktopAppLink } from "./DesktopAppLink";

describe("desktop app link", () => {
  it.each([
    ["signup", "Try the beta desktop app", "Your invite code works there too"],
    ["setup", "Try the beta", "You can also use GSV as a desktop app"],
  ] as const)("points the %s variant at the latest release page in a new tab without a referrer", (variant, label, copy) => {
    const tree = DesktopAppLink({ variant });
    const link = collectNodes(tree).find((node) => node.type === "a")!;
    expect(link.props.href).toBe("https://github.com/deathbyknowledge/gsv/releases/latest");
    expect(link.props).toMatchObject({ target: "_blank", rel: "noreferrer" });
    expect(collectText(link)).toBe(label);
    expect(collectText(tree)).toContain(copy);
  });
});
