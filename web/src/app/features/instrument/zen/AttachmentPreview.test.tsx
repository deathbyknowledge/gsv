import type { ComponentChildren, JSX, VNode } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { AttachmentPreview } from "./AttachmentPreview";
import { TEXT_PREVIEW_LIMIT } from "./attachmentKind";

let root: ReturnType<typeof createTestRoot> | undefined;
afterEach(async () => { await root?.unmount(); root = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function open(blob: Blob, filename = "attachment.txt") {
  let tree: ComponentChildren;
  const onClose = vi.fn();
  vi.stubGlobal("document", {});
  vi.stubGlobal("HTMLElement", class {});
  function Harness() {
    tree = AttachmentPreview({ blob, mimeType: blob.type, filename, description: filename, onClose });
    return null;
  }
  root = createTestRoot("Attachment preview");
  await root.render(<Harness />);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { nodes: () => collectNodes(tree), text: () => collectText(tree), onClose };
}

describe("read-only attachment viewer", () => {
  it("renders text and JSON as inert text, preserving whitespace", async () => {
    const text = '  {"html": "<script>alert(1)</script>"}\n';
    const view = await open(new Blob([text], { type: "application/json" }), "report.json");
    expect(view.nodes().find((node) => node.type === "pre")?.props.children).toBe(text);
    expect(view.nodes().some((node) => node.type === "iframe" || node.type === "object")).toBe(false);
  });

  it("keeps empty text readable instead of loading forever", async () => {
    const view = await open(new Blob([""], { type: "text/plain" }));
    expect(view.nodes().find((node) => node.type === "pre")?.props.children).toBe("");
  });

  it("bounds text decoding without removing the download", async () => {
    const blob = new Blob(["x".repeat(TEXT_PREVIEW_LIMIT + 1)], { type: "text/plain" });
    const read = vi.spyOn(blob, "arrayBuffer");
    const view = await open(blob);
    expect(read).not.toHaveBeenCalled();
    expect(view.text()).toContain("too large to preview");
    expect(view.nodes().some((node) => node.type === "a")).toBe(true);
  });

  it("shows decoding errors and retains their diagnostic details", async () => {
    const view = await open(new Blob([new Uint8Array([0xff])], { type: "text/plain" }));
    expect(view.text()).toContain("Could not load attachment.txt.");
    expect(view.nodes().some((node) => node.props.role === "alert")).toBe(true);
    expect(view.nodes().some((node) => node.type === "details")).toBe(true);
  });

  it.each(["text/html", "image/svg+xml", "application/zip"])("does not embed %s", async (type) => {
    const view = await open(new Blob(["<script>alert(1)</script>"], { type }), "file.pdf");
    expect(view.nodes().some((node) => ["iframe", "object", "img", "script"].includes(String(node.type)))).toBe(false);
    expect(view.nodes().some((node) => node.type === "a")).toBe(true);
  });

  it("embeds only the resolved PDF blob and keeps a fallback download", async () => {
    const view = await open(new Blob(["%PDF-1.4"], { type: "application/pdf" }), "report.pdf");
    const embedded = view.nodes().find((node) => node.type === "object");
    expect(embedded?.props).toMatchObject({ data: expect.stringMatching(/^blob:/), type: "application/pdf", "aria-label": "report.pdf" });
    expect(view.text()).toContain("If your browser cannot display this PDF");
  });

  it("closes explicitly or on Escape and releases its object URL", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const view = await open(new Blob(["text"], { type: "text/plain" }));
    view.nodes().find((node) => node.type === "button")?.props.onClick?.();
    expect(view.onClose).toHaveBeenCalledOnce();
    // SAFETY: The matching node is a dialog VNode; the harness omits dialog-specific attributes.
    const dialog = view.nodes().find((node) => node.type === "dialog") as VNode<JSX.DialogHTMLAttributes<HTMLDialogElement>>;
    // SAFETY: The cancel handler uses only preventDefault.
    const event = new Event("cancel", { cancelable: true }) as JSX.TargetedEvent<HTMLDialogElement>;
    dialog.props.onCancel?.(event);
    expect(event.defaultPrevented).toBe(true);
    expect(view.onClose).toHaveBeenCalledTimes(2);
    await root?.unmount();
    root = undefined;
    expect(revoke).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^blob:/));
  });
});
