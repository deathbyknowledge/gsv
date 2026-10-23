import { cloneElement, type ComponentChildren, type JSX, type VNode } from "preact";
import { useLayoutEffect } from "preact/hooks";
import { act } from "preact/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { chatProcessMediaQueryKey } from "../../../services/chat/hooks/useChatProcesses";
import { AttachmentPreview } from "./AttachmentPreview";
import { AttachmentPreviews } from "./AttachmentPreviews";
import { ZenMedia } from "./ZenMedia";

let previewTree: ComponentChildren;
const dialogElement = { showModal: vi.fn(), close: vi.fn() };

// The harness runs without a DOM, so the fixture stands in for the element: prove at runtime that it carries the two members the viewer calls.
function isDialogElement(value: unknown): value is HTMLDialogElement {
  return typeof value === "object" && value !== null && "showModal" in value && "close" in value;
}

// Keep the real viewer hooks and URL ownership; only replace DOM insertion.
function PreviewHarness(props: Parameters<typeof AttachmentPreview>[0]) {
  previewTree = AttachmentPreview(props);
  // SAFETY: AttachmentPreview returns the dialog VNode with dialog-specific attributes.
  const dialog = previewTree as VNode<JSX.DialogHTMLAttributes<HTMLDialogElement>>;
  if (!dialog.ref || !("current" in dialog.ref)) throw new Error("Expected the dialog's object ref");
  const element = dialogElement;
  if (!isDialogElement(element)) throw new Error("Expected the dialog fixture");
  dialog.ref.current = element;
  useLayoutEffect(() => () => { previewTree = null; }, []);
  return null;
}

function PreviewsHarness({ children }: { children: ComponentChildren }) {
  const provider = AttachmentPreviews({ children });
  // SAFETY: The node is selected by the exact component whose props are passed to the viewer harness.
  const preview = collectNodes(provider).find((node) => node.type === AttachmentPreview) as VNode<Parameters<typeof AttachmentPreview>[0]> | undefined;
  return cloneElement(provider, {}, children, preview ? <PreviewHarness key={preview.key} {...preview.props} /> : null);
}

let root: ReturnType<typeof createTestRoot> | undefined;
afterEach(async () => {
  await root?.unmount();
  root = undefined;
  previewTree = null;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function open() {
  let rowTree: ComponentChildren;
  class Trigger { isConnected = true; focus = vi.fn(); }
  const trigger = new Trigger();
  vi.stubGlobal("HTMLElement", Trigger);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { search: "" }, sessionStorage: { getItem: () => null } }));
  vi.stubGlobal("document", Object.assign(new EventTarget(), { activeElement: trigger }));
  const cache = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const blob = new Blob(["package main\n"], { type: "text/plain" });
  cache.setQueryData(chatProcessMediaQueryKey({ key: "source", pid: "proc:test" }), { blob });
  function Row() {
    rowTree = ZenMedia({ media: { type: "document", mimeType: blob.type, key: "source", filename: "main.go" }, processId: "proc:test" });
    useLayoutEffect(() => () => { rowTree = null; trigger.isConnected = false; }, []);
    return null;
  }
  function Shell({ showRow }: { showRow: boolean }) {
    return <GatewayProvider><QueryClientProvider client={cache}>
      <PreviewsHarness>{showRow && <Row />}</PreviewsHarness>
    </QueryClientProvider></GatewayProvider>;
  }
  root = createTestRoot("Shell-owned attachment preview");
  await root.render(<Shell showRow />);
  const rowUrl = collectNodes(rowTree).find((node) => node.type === "a")?.props.href;
  await act(() => { collectNodes(rowTree).find((node) => node.type === "button")?.props.onClick?.(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return {
    trigger,
    rowUrl,
    removeRow: () => root!.render(<Shell showRow={false} />),
    row: () => rowTree,
  };
}

describe("shell-owned attachment previews", () => {
  it.each(["close", "escape", "session teardown"])("survives source row unmount until %s", async (ending) => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const view = await open();
    const url = collectNodes(previewTree).find((node) => node.type === "a")?.props.href;
    expect(url).toMatch(/^blob:/);
    expect(url).not.toBe(view.rowUrl);
    expect(dialogElement.showModal).toHaveBeenCalledOnce();
    expect(collectText(previewTree)).toContain("package main\n");

    await view.removeRow();
    expect(view.row()).toBeNull();
    expect(collectText(previewTree)).toContain("package main\n");
    expect(dialogElement.close).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith(view.rowUrl);
    expect(revoke).not.toHaveBeenCalledWith(url);
    // The retained download still resolves to the exact authenticated bytes.
    expect(await (await fetch(url!)).text()).toBe("package main\n");

    if (ending === "session teardown") {
      await root!.unmount();
      root = undefined;
    } else {
      await act(() => {
        if (ending === "close") collectNodes(previewTree).find((node) => node.type === "button")?.props.onClick?.();
        else {
          // SAFETY: This is the dialog VNode, and cancel only reads preventDefault.
          const dialog = previewTree as VNode<JSX.DialogHTMLAttributes<HTMLDialogElement>>;
          // SAFETY: The cancel handler reads only preventDefault, supplied by this real cancelable event.
          const event = new Event("cancel", { cancelable: true }) as JSX.TargetedEvent<HTMLDialogElement>;
          dialog.props.onCancel?.(event);
          expect(event.defaultPrevented).toBe(true);
        }
      });
    }
    expect(previewTree).toBeNull();
    expect(dialogElement.close).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith(url);
    expect(view.trigger.focus).not.toHaveBeenCalled();
  });

  it("returns focus to the source action when it is still connected", async () => {
    const view = await open();
    await act(() => { collectNodes(previewTree).find((node) => node.type === "button")?.props.onClick?.(); });
    expect(view.trigger.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });
});
