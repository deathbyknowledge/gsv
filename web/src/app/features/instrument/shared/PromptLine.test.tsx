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
type PromptKeydown = Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey" | "isComposing" | "preventDefault">;
type TextareaProps = { onPaste?: (event: PasteEvent) => void; onKeyDown?: (event: PromptKeydown) => void };
type FakeInput = Pick<HTMLTextAreaElement, "value" | "selectionStart" | "selectionEnd" | "setRangeText" | "setSelectionRange" | "dispatchEvent" | "blur">;
type Renderable = { render: (props: PromptLineProps, ref: null) => ComponentChildren };

const forwarded: unknown = PromptLine;
// SAFETY: preact/compat's forwardRef exposes the wrapped component function as `render`.
const { render } = forwarded as Renderable;

let tree: ComponentChildren;
let root: ReturnType<typeof createTestRoot> | undefined;

async function mountedPrompt(onPasteText: (text: string) => boolean, onSubmit: PromptLineProps["onSubmit"] = () => true) {
  const props: PromptLineProps = {
    place: { id: "gsv", label: "your cloud", online: true },
    dir: "~",
    placeholder: "Start chatting",
    onSubmit,
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
  vi.stubGlobal("document", { activeElement: null, body: null, execCommand: () => false });
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

function attachInput(textarea: VNode<TextareaProps>, value: string) {
  const input: FakeInput = {
    value,
    selectionStart: value.length,
    selectionEnd: value.length,
    setRangeText: vi.fn(),
    setSelectionRange: vi.fn(),
    dispatchEvent: vi.fn(() => true),
    blur: vi.fn(),
  };
  const ref = textarea.ref;
  if (!ref || !("current" in ref)) throw new Error("Missing textarea ref object");
  ref.current = input;
  return input;
}

function press(init: Partial<Omit<PromptKeydown, "key" | "preventDefault">> = {}) {
  const preventDefault = vi.fn();
  const event: PromptKeydown = {
    key: "Enter",
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    isComposing: init.isComposing ?? false,
    preventDefault,
  };
  return { event, preventDefault };
}

describe("PromptLine Enter", () => {
  it("sends on Enter", async () => {
    const onSubmit = vi.fn(() => true);
    const textarea = await mountedPrompt(() => false, onSubmit);
    attachInput(textarea, "hello");
    const { event, preventDefault } = press();
    await act(async () => { textarea.props.onKeyDown!(event); });
    expect(preventDefault).toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith("hello");
  });

  it("still sends on Ctrl+Enter and Cmd+Enter", async () => {
    const onSubmit = vi.fn(() => false);
    const textarea = await mountedPrompt(() => false, onSubmit);
    attachInput(textarea, "hello");
    await act(async () => { textarea.props.onKeyDown!(press({ ctrlKey: true }).event); });
    await act(async () => { textarea.props.onKeyDown!(press({ metaKey: true }).event); });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("leaves Shift+Enter to the browser's own newline", async () => {
    const onSubmit = vi.fn(() => true);
    const textarea = await mountedPrompt(() => false, onSubmit);
    const input = attachInput(textarea, "hello");
    const { event, preventDefault } = press({ shiftKey: true });
    await act(async () => { textarea.props.onKeyDown!(event); });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(input.setRangeText).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("inserts a newline at the caret on Alt+Enter instead of sending", async () => {
    const onSubmit = vi.fn(() => true);
    const textarea = await mountedPrompt(() => false, onSubmit);
    const input = attachInput(textarea, "hello");
    const { event, preventDefault } = press({ altKey: true });
    await act(async () => { textarea.props.onKeyDown!(event); });
    expect(preventDefault).toHaveBeenCalled();
    expect(input.setRangeText).toHaveBeenCalledWith("\n", 5, 5, "end");
    expect(input.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "input" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
