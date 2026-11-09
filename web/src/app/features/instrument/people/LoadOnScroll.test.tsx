import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { LoadOnScroll } from "./LoadOnScroll";

let tree: ComponentChildren;
let root: ReturnType<typeof createTestRoot>;

function Harness({ failed, onLoad }: { failed: boolean; onLoad: () => void }) { tree = LoadOnScroll({ pages: 1, loading: false, failed, onLoad }); return null; }

beforeEach(() => {
  vi.stubGlobal("document", {});
  root = createTestRoot("load on scroll");
});
afterEach(async () => { await root.unmount(); vi.unstubAllGlobals(); });

describe("loading the next page on scroll", () => {
  it("offers nothing to press while pages load on their own", async () => {
    await root.render(<Harness failed={false} onLoad={vi.fn()} />);
    expect(collectNodes(tree).find((node) => node.type === "button")).toBeUndefined();
  });

  it("waits for a retry after a page fails", async () => {
    const onLoad = vi.fn();
    await root.render(<Harness failed onLoad={onLoad} />);
    const retry = collectNodes(tree).find((node) => node.type === "button");
    expect(collectText(retry)).toBe("retry");
    await act(async () => { await retry!.props.onClick!(); });
    expect(onLoad).toHaveBeenCalledOnce();
  });
});
