/** The parts of a textarea keydown the helpers read; a Preact keyboard event on a textarea satisfies them. */
export type TextareaKeydown = Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "isComposing" | "preventDefault">;

/** The parts of a textarea a newline is inserted into. */
export type NewlineTextarea = Pick<HTMLTextAreaElement, "selectionStart" | "selectionEnd" | "setRangeText" | "dispatchEvent">;

/**
 * Alt+Enter inserts a newline at the caret, alongside Shift+Enter, because Windows browsers give it no
 * newline of their own. The edit fires `input`, so a controlled textarea sees it like typed text.
 * Returns true, having claimed the key, when it inserted the newline.
 */
export function insertsNewline(event: TextareaKeydown, textarea: NewlineTextarea): boolean {
  if (event.key !== "Enter" || !event.altKey || event.isComposing) return false;
  event.preventDefault();
  // insertText keeps the newline on the browser's undo stack and fires `input` itself.
  if (document.execCommand("insertText", false, "\n")) return true;
  textarea.setRangeText("\n", textarea.selectionStart, textarea.selectionEnd, "end");
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

/**
 * Enter sends from a textarea, as it does in the chat composer; Shift+Enter and Alt+Enter keep the newline and an
 * IME still composing keeps its Enter. Returns true, having claimed the key, when the caller should send.
 */
export function entersToSend(event: TextareaKeydown): boolean {
  if (event.key !== "Enter" || event.shiftKey || event.altKey || event.isComposing) return false;
  event.preventDefault();
  return true;
}

/**
 * Enter submits the form a textarea sits in, and Alt+Enter inserts a newline. Going through the form leaves its own
 * guards (validity, busy, permissions) in charge of whether anything is sent.
 */
export function submitOnEnter(event: TextareaKeydown & { currentTarget: NewlineTextarea & { form: Pick<HTMLFormElement, "requestSubmit"> | null } }): void {
  if (insertsNewline(event, event.currentTarget)) return;
  if (entersToSend(event)) event.currentTarget.form?.requestSubmit();
}
