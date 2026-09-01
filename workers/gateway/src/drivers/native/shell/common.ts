import { hasCapability } from "../../../kernel/capabilities";
import type { KernelContext } from "../../../kernel/context";

export function requireCommandCapability(ctx: KernelContext, capability: string): void {
  const capabilities = ctx.identity?.capabilities ?? [];
  if (!hasCapability(capabilities, capability)) {
    throw new Error(`Permission denied: ${capability}`);
  }
}

export function requireShellOptionValue(value: string | undefined, option: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseDurationMs(value: string): number {
  const match = value.match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!match) {
    throw new Error(`invalid duration: ${value}`);
  }
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] ?? "ms";
  if (unit === "d") return amount * 24 * 60 * 60_000;
  if (unit === "h") return amount * 60 * 60_000;
  if (unit === "m") return amount * 60_000;
  if (unit === "s") return amount * 1_000;
  return amount;
}
