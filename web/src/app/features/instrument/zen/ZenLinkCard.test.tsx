import type { ComponentChildren, JSX, VNode } from "preact";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ConversationLinkPreview } from "@humansandmachines/gsv/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { linkPreviewQueryKey, ZenLinkCard, ZenLinkCards } from "./ZenLinkCard";

const LINK = "https://guide.example/start";

let root: ReturnType<typeof createTestRoot> | undefined;
afterEach(async () => { await root?.unmount(); root = undefined; vi.unstubAllGlobals(); });

async function rendered(
  view: () => ComponentChildren,
  preview?: ConversationLinkPreview,
  windowExtras: { IntersectionObserver?: new () => { observe(): void; disconnect(): void } } = {},
): Promise<ComponentChildren> {
  let tree: ComponentChildren;
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { search: "" }, sessionStorage: { getItem: () => null }, ...windowExtras }));
  vi.stubGlobal("document", new EventTarget());
  const cache = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  if (preview) cache.setQueryData(linkPreviewQueryKey(LINK), preview);
  function Harness() {
    tree = view();
    return null;
  }
  root = createTestRoot("Link preview card");
  await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness /></QueryClientProvider></GatewayProvider>);
  return tree;
}

function card(preview?: ConversationLinkPreview): Promise<ComponentChildren> {
  return rendered(() => ZenLinkCard({ url: LINK }), preview);
}

describe("link preview card", () => {
  it("takes no room while the preview is loading", async () => {
    expect(await card()).toBeNull();
  });

  it("takes no room when the page offered neither a title nor an image", async () => {
    expect(await card({ url: LINK, resolvedUrl: LINK, description: "Only a description." })).toBeNull();
  });

  it("shows the site and title and opens the link in a new tab", async () => {
    const tree = await card({ url: LINK, resolvedUrl: LINK, siteName: "Guide", title: "Getting started", description: "The first steps." });
    expect(collectText(tree)).toBe("Guide Getting started The first steps.");
    // SAFETY: The card root is an anchor VNode; the generic harness omits DOM-specific attributes.
    const anchor = collectNodes(tree).find((node) => node.type === "a") as VNode<JSX.AnchorHTMLAttributes<HTMLAnchorElement>>;
    expect(anchor.props).toMatchObject({ href: LINK, target: "_blank", rel: "noopener noreferrer" });
  });

  it("names the site by the page's host when the page gives no site name", async () => {
    const tree = await card({ url: LINK, resolvedUrl: "https://www.moved.example/start", title: "Getting started" });
    expect(collectText(tree)).toBe("moved.example Getting started");
  });

  it("renders nothing for a message without web links", async () => {
    expect(await rendered(() => ZenLinkCards({ text: "No links here, only `https://code.example`." }))).toBeNull();
  });

  it("mounts no card until the message comes near the viewport", async () => {
    class IdleObserver {
      observe(): void {}
      disconnect(): void {}
    }
    const tree = await rendered(() => ZenLinkCards({ text: `See ${LINK}.` }), undefined, { IntersectionObserver: IdleObserver });
    expect(collectNodes(tree).some((node) => node.type === ZenLinkCard)).toBe(false);
    expect(collectNodes(tree).some((node) => node.type === "div")).toBe(true);
  });

  it("lists one card per link in the message", async () => {
    const tree = await rendered(() => ZenLinkCards({ text: `See ${LINK} and [again](${LINK}), then https://other.example.` }));
    expect(collectNodes(tree).filter((node) => node.type === ZenLinkCard).map((node) => node.key)).toEqual([LINK, "https://other.example"]);
  });
});
