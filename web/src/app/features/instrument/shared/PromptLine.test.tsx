import type { ComponentChildren, VNode } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectNodes, createTestRoot } from "../../../testing/testHarness";
import { PromptLine, type PromptLineProps } from "./PromptLine";

type PasteEvent = {
  clipboardData: { files: File[]; getData: (type: string) => string };
  preventDefault: () => void;
  currentTarget: { selectionStart: number; selectionEnd: number; setRangeText: (text: string, start: number, end: number, mode: string) => void };
};
type TextareaProps = { onPaste?: (event: PasteEvent) => void };
type Renderable = { render: (props: PromptLineProps, ref: null) => ComponentChildren };

const forwarded: unknown = PromptLine;
// SAFETY: preact/compat's forwardRef exposes the wrapped component function as `render`.
const { render } = forwarded as Renderable;

let tree: ComponentChildren;
let root: ReturnType<typeof createTestRoot> | undefined;

async function mountedPrompt(onPasteText: (text: string) => boolean) {
  const props: PromptLineProps = {
    place: { id: "gsv", label: "your cloud", online: true },
    dir: "~",
    placeholder: "Start chatting",
    onSubmit: () => true,
    onPasteText,
  };
  function Harness() {
    tree = render(props, null);
    return null;
  }
  root = createTestRoot("PromptLine");
  await root.render(<Harness />);
  // SAFETY: the textarea is the explicitly rendered prompt element.
  const textarea = collectNodes(tree).find((node) => node.type === "textarea") as VNode<TextareaProps> | undefined;
  if (!textarea) throw new Error("Missing textarea");
  return textarea;
}

function paste(text: string, selection: [number, number]) {
  const preventDefault = vi.fn();
  const setRangeText = vi.fn();
  const event: PasteEvent = {
    clipboardData: { files: [], getData: () => text },
    preventDefault,
    currentTarget: { selectionStart: selection[0], selectionEnd: selection[1], setRangeText },
  };
  return { event, preventDefault, setRangeText };
}

beforeEach(() => {
  vi.stubGlobal("document", { activeElement: null, body: null });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});
afterEach(async () => { await root?.unmount(); root = undefined; vi.unstubAllGlobals(); });

describe("PromptLine paste", () => {
  it("removes the selected text when a paste is taken as a chip, so the replaced words do not stay", async () => {
    const textarea = await mountedPrompt(() => true);
    const { event, preventDefault, setRangeText } = paste("x".repeat(500), [5, 8]);
    await act(() => { textarea.props.onPaste!(event); });
    expect(preventDefault).toHaveBeenCalled();
    expect(setRangeText).toHaveBeenCalledWith("", 5, 8, "end");
  });

  it("leaves a collapsed caret alone when a paste is taken as a chip", async () => {
    const textarea = await mountedPrompt(() => true);
    const { event, preventDefault, setRangeText } = paste("x".repeat(500), [8, 8]);
    await act(() => { textarea.props.onPaste!(event); });
    expect(preventDefault).toHaveBeenCalled();
    expect(setRangeText).not.toHaveBeenCalled();
  });

  it("lets the browser paste as usual when the text is not taken", async () => {
    const textarea = await mountedPrompt(() => false);
    const { event, preventDefault, setRangeText } = paste("short", [5, 8]);
    await act(() => { textarea.props.onPaste!(event); });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(setRangeText).not.toHaveBeenCalled();
  });
});
