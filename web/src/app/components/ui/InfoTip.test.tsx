import type { ComponentChildren } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectNodes, createTestRoot } from "../../testing/testHarness";
import { InfoTip, type InfoTipProps } from "./InfoTip";
import { Hint } from "./Tooltip";

async function infoTipTree(props: InfoTipProps): Promise<ComponentChildren> {
  const root = createTestRoot("info tip");
  let tree: ComponentChildren;
  function Harness() { tree = InfoTip(props); return null; }
  try {
    await root.render(<Harness />);
  } finally {
    await root.unmount();
  }
  return tree;
}

beforeEach(() => vi.stubGlobal("document", {}));
afterEach(() => vi.unstubAllGlobals());

describe("InfoTip", () => {
  it("opens on tap because its icon has no action of its own", async () => {
    const hint = collectNodes(await infoTipTree({ text: "Nothing runs until you answer.", label: "About this approval" })).find((node) => node.type === Hint);
    expect(hint?.props).toMatchObject({ text: "Nothing runs until you answer.", openOnTap: true });
  });
});
