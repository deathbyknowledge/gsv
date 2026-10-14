/** These functions execute in the selected element's document through CDP. */
export type FormState = {
  connected: boolean;
  visible: boolean;
  disabled: boolean;
  readOnly: boolean;
  type: string;
  value?: string;
  valueLength?: number;
  checked?: boolean;
  selected?: Array<{ value: string; label: string }>;
  matches?: boolean;
};

export function readFormState(this: Element, expected?: string): FormState {
  const input = this instanceof HTMLInputElement;
  const text = input || this instanceof HTMLTextAreaElement;
  const editable = this instanceof HTMLElement && this.isContentEditable;
  const value = text ? this.value : editable ? this.textContent ?? "" : undefined;
  const password = input && this.type === "password";
  const rect = this.getBoundingClientRect(), style = getComputedStyle(this);
  const checked = input && (this.type === "checkbox" || this.type === "radio") ? this.checked
    : this.hasAttribute("aria-checked") ? this.getAttribute("aria-checked") === "true" : undefined;
  const state: FormState = {
    connected: this.isConnected,
    visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none",
    disabled: this.matches(":disabled") || this.getAttribute("aria-disabled") === "true",
    readOnly: (text && this.readOnly) || this.getAttribute("aria-readonly") === "true",
    type: input ? this.type : editable ? "contenteditable" : this.tagName.toLowerCase(),
  };
  if (password) state.valueLength = value?.length;
  else if (value !== undefined) state.value = value;
  if (checked !== undefined) state.checked = checked;
  if (this instanceof HTMLSelectElement) state.selected = Array.from(this.selectedOptions, option => ({ value: option.value, label: option.label }));
  if (expected !== undefined) state.matches = value === expected;
  return state;
}

export function prepareFill(this: Element, value: string): "insert" | "set" {
  if (this instanceof HTMLInputElement) {
    const type = this.type;
    if (["date", "time", "datetime-local", "month", "week"].includes(type)) {
      const probe = this.ownerDocument.createElement("input");
      probe.type = type; probe.value = value;
      if (probe.value !== value) throw new Error(`Invalid ${type} value; use the native format (for example 10:00 or 2026-10-10).`);
      this.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(this, value);
      this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
      return "set";
    }
    if (!["text", "email", "number", "password", "search", "tel", "url"].includes(type)) {
      throw new Error(`Cannot fill input type=${type}. Use page check for checkboxes or page select for native dropdowns.`);
    }
    if (type === "number" && value !== "" && !Number.isFinite(Number(value))) throw new Error("A number field requires a numeric value.");
    this.focus(); this.select();
    return "insert";
  }
  if (this instanceof HTMLTextAreaElement) { this.focus(); this.select(); return "insert"; }
  if (this instanceof HTMLElement && this.isContentEditable) {
    this.focus();
    const range = this.ownerDocument.createRange(); range.selectNodeContents(this);
    const selection = this.ownerDocument.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    return "insert";
  }
  throw new Error("Fill requires an input, textarea, or contenteditable field. Use page snapshot to find the actual field.");
}

export function selectOption(this: Element, value: string, byLabel: boolean): Array<{ value: string; label: string }> {
  if (!(this instanceof HTMLSelectElement)) throw new Error("Select requires a native dropdown. For a custom listbox, click its option by role and name.");
  const matches = Array.from(this.options).filter(option => (byLabel ? option.label : option.value) === value);
  if (matches.length !== 1) throw new Error(`Option matches ${matches.length} choices; use a unique ${byLabel ? "label" : "value"}.`);
  const chosen = matches[0]!;
  if (chosen.disabled || (chosen.parentElement instanceof HTMLOptGroupElement && chosen.parentElement.disabled)) throw new Error("The requested option is disabled.");
  this.focus();
  for (const option of Array.from(this.options)) option.selected = option === chosen;
  this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return [{ value: chosen.value, label: chosen.label }];
}
