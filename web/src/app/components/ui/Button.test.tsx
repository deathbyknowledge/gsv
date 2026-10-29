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

interface AnchorClick {
  preventDefault: ReturnType<typeof vi.fn>;
  currentTarget: { closest: (selector: string) => object | null };
}

function anchorProps(tree: ComponentChildren) {
  const anchor = collectNodes(tree).find((node) => node.type === "a");
  if (!anchor) throw new Error("expected the link-button to render an anchor");
  // SAFETY: the anchor's props are the test subject.
  return anchor.props as { href: string; onClick: (event: AnchorClick) => void };
}

function clickEvent(insideDisabledFieldset: boolean): AnchorClick {
  return {
    preventDefault: vi.fn(),
    currentTarget: { closest: (selector: string) => (selector === "fieldset:disabled" && insideDisabledFieldset ? {} : null) },
  };
}

beforeEach(() => vi.stubGlobal("document", {}));
afterEach(() => vi.unstubAllGlobals());

describe("Button with href", () => {
  it("goes inert inside a disabled fieldset, which cannot disable an anchor itself", async () => {
    const onClick = vi.fn();
    const props = anchorProps(await buttonTree({ href: "https://wa.me/1", label: "Connect", onClick }));
    const event = clickEvent(true);
    props.onClick(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("follows its link and reports the click outside a disabled fieldset", async () => {
    const onClick = vi.fn();
    const props = anchorProps(await buttonTree({ href: "https://wa.me/1", label: "Connect", onClick }));
    const event = clickEvent(false);
    props.onClick(event);
    expect(props.href).toBe("https://wa.me/1");
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
