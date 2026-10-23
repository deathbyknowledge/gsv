/** The parts of a textarea keydown the helpers read; a Preact keyboard event on a textarea satisfies them. */
export type TextareaKeydown = Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing" | "preventDefault">;

/**
 * Enter sends from a textarea, as it does in the chat composer; Shift+Enter keeps the newline and an
 * IME still composing keeps its Enter. Returns true, having claimed the key, when the caller should send.
 */
export function entersToSend(event: TextareaKeydown): boolean {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return false;
  event.preventDefault();
  return true;
}

/**
 * Enter submits the form a textarea sits in. Going through the form leaves its own guards
 * (validity, busy, permissions) in charge of whether anything is sent.
 */
export function submitOnEnter(event: TextareaKeydown & { currentTarget: { form: Pick<HTMLFormElement, "requestSubmit"> | null } }): void {
  if (entersToSend(event)) event.currentTarget.form?.requestSubmit();
}
