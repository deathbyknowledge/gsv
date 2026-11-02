import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { entersToSend, insertsNewline, submitOnEnter, type NewlineTextarea, type TextareaKeydown } from "./enterToSend";

type Modifiers = { shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean };
type Keydown = TextareaKeydown & Pick<KeyboardEvent, "ctrlKey" | "metaKey">;

function keydown(key: string, init: Modifiers = {}) {
  const preventDefault = vi.fn();
  const event: Keydown = {
    key,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    isComposing: init.isComposing ?? false,
    preventDefault,
  };
  return { event, preventDefault };
}

function textarea(selection: [number, number] = [5, 5]) {
  const setRangeText = vi.fn();
  const dispatchEvent = vi.fn(() => true);
  const requestSubmit = vi.fn();
  const target: NewlineTextarea & { form: Pick<HTMLFormElement, "requestSubmit"> } = {
    selectionStart: selection[0],
    selectionEnd: selection[1],
    setRangeText,
    dispatchEvent,
    form: { requestSubmit },
  };
  return { target, setRangeText, dispatchEvent, requestSubmit };
}

const execCommand = vi.fn(() => true);
beforeEach(() => {
  execCommand.mockReset();
  execCommand.mockReturnValue(true);
  vi.stubGlobal("document", { execCommand });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("entersToSend", () => {
  it("claims plain Enter", () => {
    const { event, preventDefault } = keydown("Enter");
    expect(entersToSend(event)).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("leaves Shift+Enter as a newline", () => {
    const { event, preventDefault } = keydown("Enter", { shiftKey: true });
    expect(entersToSend(event)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("does not send on Alt+Enter", () => {
    const { event, preventDefault } = keydown("Enter", { altKey: true });
    expect(entersToSend(event)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("still sends on Ctrl+Enter and Cmd+Enter", () => {
    expect(entersToSend(keydown("Enter", { ctrlKey: true }).event)).toBe(true);
    expect(entersToSend(keydown("Enter", { metaKey: true }).event)).toBe(true);
  });

  it("leaves Enter to an IME that is still composing", () => {
    const { event } = keydown("Enter", { isComposing: true });
    expect(entersToSend(event)).toBe(false);
  });

  it("ignores other keys", () => {
    const { event, preventDefault } = keydown("a");
    expect(entersToSend(event)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe("insertsNewline", () => {
  it("inserts a newline on Alt+Enter through the browser's editing command", () => {
    const { event, preventDefault } = keydown("Enter", { altKey: true });
    const { target, setRangeText } = textarea();
    expect(insertsNewline(event, target)).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(execCommand).toHaveBeenCalledWith("insertText", false, "\n");
    expect(setRangeText).not.toHaveBeenCalled();
  });

  it("replaces the selection and reports the input itself when the editing command is unavailable", () => {
    execCommand.mockReturnValue(false);
    const { event } = keydown("Enter", { altKey: true });
    const { target, setRangeText, dispatchEvent } = textarea([2, 6]);
    expect(insertsNewline(event, target)).toBe(true);
    expect(setRangeText).toHaveBeenCalledWith("\n", 2, 6, "end");
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "input", bubbles: true }));
  });

  it("leaves Enter, Shift+Enter, Ctrl+Enter and a composing IME alone", () => {
    for (const init of [{}, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true, isComposing: true }]) {
      const { event, preventDefault } = keydown("Enter", init);
      expect(insertsNewline(event, textarea().target)).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
    }
    expect(execCommand).not.toHaveBeenCalled();
  });
});

describe("submitOnEnter", () => {
  it("submits the textarea's form on Enter", () => {
    const { target, requestSubmit } = textarea();
    submitOnEnter({ ...keydown("Enter").event, currentTarget: target });
    expect(requestSubmit).toHaveBeenCalledOnce();
  });

  it("submits on Ctrl+Enter and Cmd+Enter", () => {
    const { target, requestSubmit } = textarea();
    submitOnEnter({ ...keydown("Enter", { ctrlKey: true }).event, currentTarget: target });
    submitOnEnter({ ...keydown("Enter", { metaKey: true }).event, currentTarget: target });
    expect(requestSubmit).toHaveBeenCalledTimes(2);
  });

  it("does not submit on Shift+Enter", () => {
    const { target, requestSubmit } = textarea();
    submitOnEnter({ ...keydown("Enter", { shiftKey: true }).event, currentTarget: target });
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it("inserts a newline instead of submitting on Alt+Enter", () => {
    const { target, requestSubmit } = textarea();
    const { event, preventDefault } = keydown("Enter", { altKey: true });
    submitOnEnter({ ...event, currentTarget: target });
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(execCommand).toHaveBeenCalledWith("insertText", false, "\n");
  });

  it("tolerates a textarea outside any form", () => {
    const { target } = textarea();
    const { event, preventDefault } = keydown("Enter");
    submitOnEnter({ ...event, currentTarget: { ...target, form: null } });
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
