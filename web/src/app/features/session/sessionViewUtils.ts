export function textInputValue(event: Event): string {
  return (event.currentTarget as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
}

export function checkedInputValue(event: Event): boolean {
  return (event.currentTarget as HTMLInputElement).checked;
}
