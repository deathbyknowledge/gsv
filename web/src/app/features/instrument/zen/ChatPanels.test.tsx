import type { ComponentChildren, ComponentProps, ComponentType } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsoleTarget } from "../../../domain/system/consoleModels";
import { cloudPlace } from "../fleet/fleetModel";
import { collectNodes, createTestRoot } from "../../../testing/testHarness";
import { FilePreview } from "../shared/FilePreview";
import { PlaceTree } from "../shared/PlaceFiles";
import { ChatPath } from "./ChatPanels";

async function mountedPath(location: ComponentProps<typeof ChatPath>["location"], targets: readonly ConsoleTarget[] = []) {
  const root = createTestRoot("chat path");
  let tree: ComponentChildren;
  const onAsk = vi.fn();
  const onFleet = vi.fn();
  const onClose = vi.fn();
  function Harness() { tree = ChatPath({ location, targets, ready: true, allowed: true, onAsk, onFleet, onClose }); return null; }
  await root.render(<Harness />);
  const props = <P,>(component: ComponentType<P>): P => {
    const node = collectNodes(tree).find((entry) => entry.type === component);
    if (!node) throw new Error(`Missing ${component.name}`);
    // SAFETY: The VNode was selected by the exact component whose props type P describes.
    return node.props as P;
  };
  const has = (component: ComponentType<never>) => collectNodes(tree).some((entry) => entry.type === component);
  return { props, has, onAsk, onFleet, onClose, unmount: () => root.unmount() };
}

describe("ChatPath", () => {
  beforeEach(() => vi.stubGlobal("document", {}));
  afterEach(() => vi.unstubAllGlobals());

  it("previews a linked file in place and offers Work for the full tree", async () => {
    const view = await mountedPath({ kind: "file", target: "gsv", path: "/home/x/notes/plan.md" });
    try {
      const preview = view.props(FilePreview);
      expect(preview.file).toEqual({ target: "gsv", path: "/home/x/notes/plan.md", name: "plan.md" });
      expect(preview.placeLabel).toBe(cloudPlace().label);
      expect(preview.expandLabel).toBe("open in Work");
      preview.onExpand?.();
      expect(view.onFleet).toHaveBeenCalledWith("file:gsv:/home/x/notes/plan.md");
      preview.onClose();
      expect(view.onClose).toHaveBeenCalledTimes(1);
    } finally { await view.unmount(); }
  });

  it("opens a linked folder as its tree, and a file from that tree in place with a way back", async () => {
    const view = await mountedPath({ kind: "dir", target: "gsv", path: "~/notes/" });
    try {
      expect(view.has(FilePreview)).toBe(false);
      const tree = view.props(PlaceTree);
      expect(tree.initialPath).toBe("~/notes/");
      expect(tree.place.id).toBe("gsv");
      await act(() => { tree.onOpenFile({ target: "gsv", path: "~/notes/calls/mara.md", name: "mara.md" }); });
      expect(view.props(FilePreview).file.name).toBe("mara.md");
      await act(() => { view.props(FilePreview).onClose(); });
      expect(view.has(FilePreview)).toBe(false);
      expect(view.props(PlaceTree).initialPath).toBe("~/notes/");
      expect(view.onClose).not.toHaveBeenCalled();
    } finally { await view.unmount(); }
  });

  it("says so when the linked place is not connected", async () => {
    const view = await mountedPath({ kind: "dir", target: "laptop", path: "/srv/" });
    try {
      expect(view.has(PlaceTree)).toBe(false);
      expect(view.has(FilePreview)).toBe(false);
    } finally { await view.unmount(); }
  });
});
