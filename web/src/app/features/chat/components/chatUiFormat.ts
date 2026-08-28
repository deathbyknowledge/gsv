export function shortId(value: string | null | undefined): string {
  return value ? value.slice(0, 8) : "";
}

export function formatCount<T>(value: T): string {
  const parsed = z.number().finite().safeParse(value);
  return parsed.success ? parsed.data.toLocaleString() : "UNKNOWN";
}

export function formatCompactCount<T>(value: T): string {
  const parsed = z.number().finite().safeParse(value);
  return parsed.success
    ? new Intl.NumberFormat(undefined, {
        maximumFractionDigits: 1,
        notation: "compact",
      }).format(parsed.data)
    : "UNKNOWN";
}

export function formatCurrencyCost<T>(value: T): string {
  const parsed = z.number().finite().safeParse(value);
  if (!parsed.success || parsed.data <= 0) {
    return "$0.00";
  }
  if (parsed.data >= 1) {
    return `$${parsed.data.toFixed(2)}`;
  }
  if (parsed.data >= 0.01) {
    return `$${parsed.data.toFixed(4)}`;
  }
  return `$${parsed.data.toFixed(6)}`;
}
import { z } from "zod";
