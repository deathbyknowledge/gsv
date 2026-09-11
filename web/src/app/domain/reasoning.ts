export const REASONING_VALUES = ["", "off", "minimal", "low", "medium", "high", "xhigh"];

export function reasoningIndexForValue(value: string | undefined): number {
  const trimmed = value?.trim().toLowerCase() ?? "";
  if (!trimmed || trimmed === "inherit") {
    return 0;
  }
  const index = REASONING_VALUES.indexOf(trimmed);
  return index >= 0 ? index : 0;
}

function reasoningOptionLabel(value: string): string {
  if (!value) return "Inherit default";
  if (value === "xhigh") return "Extra high";
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function reasoningOptions(inherited: string | undefined): { value: string; label: string }[] {
  const inheritedLabel = inherited?.trim();
  return REASONING_VALUES.map((value) => value
    ? { label: reasoningOptionLabel(value), value }
    : {
        label: inheritedLabel ? `Inherit: ${reasoningOptionLabel(inheritedLabel)}` : "Inherit default",
        value: "",
      });
}
