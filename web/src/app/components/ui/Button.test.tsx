import type { ComponentChildren } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectNodes, createTestRoot } from "../../testing/testHarness";
import { Button, type ButtonProps } from "./Button";

async function buttonTree(props: ButtonProps): Promise<ComponentChildren> {
  const root = createTestRoot("button");
  let tree: ComponentChildren;
  function Harness() { tree = Button(props); return null; }
  try {
    await root.render(<Harness />);
  } finally {
    await root.unmount();
  }
  return tree;
}

beforeEach(() => vi.stubGlobal("document", {}));
afterEach(() => vi.unstubAllGlobals());

describe("Button with href", () => {
  it("renders a real link that opens an outside destination in a new tab and reports the click", async () => {
    const onClick = vi.fn();
    const anchor = collectNodes(await buttonTree({ href: "https://wa.me/1", label: "Connect", onClick })).find((node) => node.type === "a");
    if (!anchor) throw new Error("expected the link-button to render an anchor");
    expect(anchor.props).toMatchObject({ href: "https://wa.me/1", target: "_blank", rel: "noreferrer noopener" });
    // SAFETY: the anchor's click handler is the test subject.
    (anchor.props as { onClick: () => void }).onClick();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("becomes a disabled button with no link while disabled, so neither a click nor Enter can follow it", async () => {
    const nodes = collectNodes(await buttonTree({ href: "https://wa.me/1", label: "Connect", disabled: true }));
    expect(nodes.some((node) => node.type === "a")).toBe(false);
    expect(nodes.find((node) => node.type === "button")?.props).toMatchObject({ disabled: true });
  });
});
