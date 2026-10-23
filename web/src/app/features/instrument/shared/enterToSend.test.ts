import { describe, expect, it, vi } from "vitest";
import { entersToSend, submitOnEnter, type TextareaKeydown } from "./enterToSend";

function keydown(init: { key: string; shiftKey?: boolean; isComposing?: boolean }) {
  const preventDefault = vi.fn();
  const event: TextareaKeydown = { key: init.key, shiftKey: init.shiftKey ?? false, isComposing: init.isComposing ?? false, preventDefault };
  return { event, preventDefault };
}

describe("entersToSend", () => {
  it("claims plain Enter", () => {
    const { event, preventDefault } = keydown({ key: "Enter" });
    expect(entersToSend(event)).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("leaves Shift+Enter as a newline", () => {
    const { event, preventDefault } = keydown({ key: "Enter", shiftKey: true });
    expect(entersToSend(event)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("leaves Enter to an IME that is still composing", () => {
    const { event } = keydown({ key: "Enter", isComposing: true });
    expect(entersToSend(event)).toBe(false);
  });

  it("ignores other keys", () => {
    const { event, preventDefault } = keydown({ key: "a" });
    expect(entersToSend(event)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe("submitOnEnter", () => {
  it("submits the textarea's form on Enter", () => {
    const requestSubmit = vi.fn();
    const { event } = keydown({ key: "Enter" });
    submitOnEnter({ ...event, currentTarget: { form: { requestSubmit } } });
    expect(requestSubmit).toHaveBeenCalledOnce();
  });

  it("does not submit on Shift+Enter", () => {
    const requestSubmit = vi.fn();
    const { event } = keydown({ key: "Enter", shiftKey: true });
    submitOnEnter({ ...event, currentTarget: { form: { requestSubmit } } });
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it("tolerates a textarea outside any form", () => {
    const { event, preventDefault } = keydown({ key: "Enter" });
    submitOnEnter({ ...event, currentTarget: { form: null } });
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
