import type { ComponentChildren, JSX, VNode } from "preact";
import { act } from "preact/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { MediaPreviewProvider } from "../../../services/platform/MediaPreview";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { chatProcessMediaQueryKey } from "../../../services/chat/hooks/useChatProcesses";
import { AttachmentPreview } from "./AttachmentPreview";
import { AttachmentPreviews } from "./AttachmentPreviews";
import { ZenDraftPaste, ZenMedia } from "./ZenMedia";

vi.mock("./AttachmentPreview", () => ({ AttachmentPreview: vi.fn(() => null) }));

let root: ReturnType<typeof createTestRoot> | undefined;
afterEach(async () => { await root?.unmount(); root = undefined; vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function links(desktop: boolean, type: "image" | "document", mimeType: string, url?: string) {
  let tree: ComponentChildren;
  const preview = vi.fn();
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { search: "" }, sessionStorage: { getItem: () => null } }));
  vi.stubGlobal("document", new EventTarget());
  const cache = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  cache.setQueryData(chatProcessMediaQueryKey({ key: "image", pid: "proc:test" }), { blob: new Blob(["fixture"], { type: mimeType }) });
  function Harness() {
    tree = ZenMedia({ media: { type, mimeType, key: "image", filename: "attachment.png", url }, processId: "proc:test" });
    return null;
  }
  root = createTestRoot("Attachment actions");
  await root.render(<GatewayProvider><QueryClientProvider client={cache}>
    <AttachmentPreviews>{desktop ? <MediaPreviewProvider preview={preview}><Harness /></MediaPreviewProvider> : <Harness />}</AttachmentPreviews>
  </QueryClientProvider></GatewayProvider>);
  // SAFETY: All matching nodes are anchor VNodes; the generic harness omits DOM-specific attributes.
  const anchors = collectNodes(tree).filter((node) => node.type === "a") as VNode<JSX.AnchorHTMLAttributes<HTMLAnchorElement>>[];
  return { anchors, preview, nodes: () => collectNodes(tree) };
}

describe("attachment opening", () => {
  it("opens browser images in the app without downloading or navigating", async () => {
    const { anchors, preview } = await links(false, "image", "image/png");
    // SAFETY: The anchor handler only uses Event.preventDefault.
    const event = new Event("click", { cancelable: true }) as JSX.TargetedMouseEvent<HTMLAnchorElement>;
    await act(() => { anchors[0].props.onClick?.(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(AttachmentPreview).toHaveBeenCalledWith(expect.objectContaining({ blob: expect.any(Blob), mimeType: "image/png" }), expect.anything());
    expect(preview).not.toHaveBeenCalled();
    expect(anchors[1].props.download).toBe("attachment.png");
  });

  it.each(["text/plain", "text/markdown", "application/json", "application/pdf"])("opens %s from the filename and keeps download explicit", async (mimeType) => {
    const { anchors, nodes } = await links(false, "document", mimeType);
    const open = nodes().find((node) => node.type === "button");
    expect(collectText(open)).toBe("attachment.png");
    await act(() => open?.props.onClick?.());
    expect(AttachmentPreview).toHaveBeenCalledWith(expect.objectContaining({ blob: expect.any(Blob), mimeType }), expect.anything());
    expect(anchors).toHaveLength(1);
    expect(collectText(anchors[0])).toBe("download");
    expect(anchors[0].props.download).toBe("attachment.png");
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

  it.each([false, true])("keeps legacy remote files outside the current app (desktop: %s)", async (desktop) => {
    const source = "https://attachments.example/report.html";
    const { anchors } = await links(desktop, "document", "text/html", source);
    expect(anchors[0].props).toMatchObject({ href: source, download: "attachment.png", target: "_blank", rel: "noreferrer" });
    expect(anchors[0].props.onClick).toBeUndefined();
  });

  it.each([["image", "image/svg+xml"], ["document", "text/html"]] as const)("keeps %s %s download links non-executable", async (type, mimeType) => {
    const { anchors, preview } = await links(true, type, mimeType);
    for (const anchor of anchors) {
      expect(anchor.props.download).toBe("attachment.png");
      expect(anchor.props.target).toBeUndefined();
      expect(anchor.props.onClick).toBeUndefined();
    }
    expect(preview).not.toHaveBeenCalled();
  });
});

/** Rendered through compat, the input handler lands on the lowercase prop. */
type EditorProps = JSX.TextareaHTMLAttributes<HTMLTextAreaElement> & { oninput?: JSX.InputEventHandler<HTMLTextAreaElement> };

describe("pasted text chip", () => {
  it("keeps the complete paste in collapsed details and removes it on request", async () => {
    const onRemove = vi.fn();
    const text = `${"x".repeat(434)}!`;
    let tree: ComponentChildren;
    function Harness() {
      tree = ZenDraftPaste({ paste: { id: "paste", text, characters: 435 }, onRemove });
      return null;
    }
    vi.stubGlobal("document", {});
    root = createTestRoot("Pasted text chip");
    await root.render(<Harness />);
    const nodes = collectNodes(tree);
    expect(collectText(nodes.find((node) => node.type === "summary"))).toContain("435 characters");
    expect(collectText(nodes.find((node) => node.type === "summary"))).not.toContain(text);
    expect(nodes.find((node) => node.type === "pre")?.props.children).toBe(text);
    expect(nodes.find((node) => node.type === "details")?.props).not.toHaveProperty("open", true);
    const remove = collectNodes(tree).find((node) => node.type === "button");
    remove?.props.onClick?.();
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("edits the paste in place when the composer accepts changes", async () => {
    const onChange = vi.fn();
    const text = `${"y".repeat(434)}?`;
    let tree: ComponentChildren;
    function Harness() {
      tree = ZenDraftPaste({ paste: { id: "paste", text, characters: 435 }, onChange });
      return null;
    }
    vi.stubGlobal("document", {});
    root = createTestRoot("Pasted text editor");
    await root.render(<Harness />);
    const nodes = collectNodes(tree);
    expect(nodes.some((node) => node.type === "pre")).toBe(false);
    // SAFETY: The matching node is the textarea VNode; the generic harness omits DOM-specific attributes.
    const editor = nodes.find((node) => node.type === "textarea") as VNode<EditorProps> | undefined;
    expect(editor?.props.value).toBe(text);
    expect(editor?.props["aria-label"]).toBe("Edit pasted text");
    const stopPropagation = vi.fn();
    const keydown: Partial<JSX.TargetedKeyboardEvent<HTMLTextAreaElement>> = { key: "Enter", stopPropagation };
    // SAFETY: the handler reads only stopPropagation from the event.
    editor?.props.onKeyDown?.(keydown as JSX.TargetedKeyboardEvent<HTMLTextAreaElement>);
    expect(stopPropagation).toHaveBeenCalledOnce();
    // SAFETY: the handler reads only currentTarget.value from the event.
    const edited = { value: "edited draft" } as HTMLTextAreaElement;
    const input: Partial<JSX.TargetedInputEvent<HTMLTextAreaElement>> = { currentTarget: edited };
    // SAFETY: the handler reads only currentTarget.value from the event.
    (editor?.props.onInput ?? editor?.props.oninput)?.(input as JSX.TargetedInputEvent<HTMLTextAreaElement>);
    expect(onChange).toHaveBeenCalledWith("edited draft");
  });
});
