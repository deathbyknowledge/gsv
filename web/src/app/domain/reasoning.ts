import { t, type TextKey } from "../i18n/locale";

export const REASONING_VALUES = ["", "off", "minimal", "low", "medium", "high", "xhigh"];

export function reasoningIndexForValue(value: string | undefined): number {
  const trimmed = value?.trim().toLowerCase() ?? "";
  if (!trimmed || trimmed === "inherit") {
    return 0;
  }
  const index = REASONING_VALUES.indexOf(trimmed);
  return index >= 0 ? index : 0;
}

const REASONING_LABELS = new Map(Object.entries({
  off: "reasoning.off",
  minimal: "reasoning.minimal",
  low: "reasoning.low",
  medium: "reasoning.medium",
  high: "reasoning.high",
  xhigh: "reasoning.xhigh",
} satisfies Record<string, TextKey>));

function reasoningOptionLabel(value: string): string {
  const label = REASONING_LABELS.get(value);
  return label ? t(label) : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function reasoningOptions(inherited: string | undefined): { value: string; label: string }[] {
  const inheritedLabel = inherited?.trim();
  return REASONING_VALUES.map((value) => value
    ? { label: reasoningOptionLabel(value), value }
    : {
        label: inheritedLabel ? t("reasoning.inherit", { level: reasoningOptionLabel(inheritedLabel) }) : t("reasoning.inheritDefault"),
        value: "",
      });
}
