import type { ComponentChildren, JSX, VNode } from "preact";
import { act } from "preact/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectNodes, createTestRoot } from "../../../testing/testHarness";
import { MediaPreviewProvider } from "../../../services/platform/MediaPreview";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { chatProcessMediaQueryKey } from "../../../services/chat/hooks/useChatProcesses";
import { ZenMedia } from "./ZenMedia";

let root: ReturnType<typeof createTestRoot>;
afterEach(async () => { await root?.unmount(); vi.unstubAllGlobals(); });

async function links(desktop: boolean, type: "image" | "document", mimeType: string) {
  let tree: ComponentChildren;
  const preview = vi.fn();
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { search: "" }, sessionStorage: { getItem: () => null } }));
  vi.stubGlobal("document", new EventTarget());
  const cache = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  cache.setQueryData(chatProcessMediaQueryKey({ key: "image", pid: "proc:test" }), { blob: new Blob(["fixture"], { type: mimeType }) });
  function Harness() {
    tree = ZenMedia({ media: { type, mimeType, key: "image", filename: "attachment.png" }, processId: "proc:test" });
    return null;
  }
  root = createTestRoot("Attachment actions");
  await root.render(<GatewayProvider><QueryClientProvider client={cache}>
    {desktop ? <MediaPreviewProvider preview={preview}><Harness /></MediaPreviewProvider> : <Harness />}
  </QueryClientProvider></GatewayProvider>);
  // SAFETY: All matching nodes are anchor VNodes; the generic harness omits DOM-specific attributes.
  const anchors = collectNodes(tree).filter((node) => node.type === "a") as VNode<JSX.AnchorHTMLAttributes<HTMLAnchorElement>>[];
  return { anchors, preview };
}

describe("attachment opening", () => {
  it("keeps browser image previews as normal links", async () => {
    const { anchors, preview } = await links(false, "image", "image/png");
    expect(anchors[0].props.target).toBe("_blank");
    expect(anchors[0].props.onClick).toBeUndefined();
    expect(preview).not.toHaveBeenCalled();
  });

  it("opens an image through the desktop viewer without navigating the webview", async () => {
    const { anchors, preview } = await links(true, "image", "image/png");
    // SAFETY: The anchor handler only uses Event.preventDefault, supplied by this real cancelable event.
    const event = new Event("click", { cancelable: true }) as JSX.TargetedMouseEvent<HTMLAnchorElement>;
    await act(() => { anchors[0].props.onClick?.(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(preview).toHaveBeenCalledExactlyOnceWith({ source: expect.stringMatching(/^blob:/), filename: "attachment.png", description: "attachment.png" });
    expect(anchors[1].props).toMatchObject({ download: "attachment.png" });
    expect(anchors[1].props.target).toBeUndefined();
  });

  it.each([["image", "image/svg+xml"], ["document", "text/html"]] as const)("downloads %s %s without opening executable content", async (type, mimeType) => {
    const { anchors, preview } = await links(true, type, mimeType);
    for (const anchor of anchors) {
      expect(anchor.props.download).toBe("attachment.png");
      expect(anchor.props.target).toBeUndefined();
      expect(anchor.props.onClick).toBeUndefined();
    }
    expect(preview).not.toHaveBeenCalled();
  });
});
