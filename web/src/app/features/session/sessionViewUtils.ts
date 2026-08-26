export function textInputValue(event: Event): string {
  const target = event.currentTarget;
  if (
    target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
  ) {
    return target.value;
  }
  throw new TypeError("Expected a text input event");
}

export function checkedInputValue(event: Event): boolean {
  const target = event.currentTarget;
  if (target instanceof HTMLInputElement) {
    return target.checked;
  }
  throw new TypeError("Expected a checkbox input event");
}
