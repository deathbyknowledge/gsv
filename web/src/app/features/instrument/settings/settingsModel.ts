import { z } from "zod";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";

export {
  consoleConfigQueryKey as SETTINGS_CONFIG_KEY,
  consoleModelsQueryKey as SETTINGS_MODELS_KEY,
  consoleMcpServersQueryKey as SETTINGS_MCP_KEY,
} from "../../../services/system/useConsoleData";
export const SETTINGS_INSTRUCTIONS_KEY = ["instrument", "settings", "instructions"] as const;

export function canConfigure(account: ConsoleAccount, syscall: string): boolean {
  return account.uid === 0 || account.capabilities.some((capability) =>
    capability === "*" || capability === syscall
    || (capability.endsWith(".*") && syscall.startsWith(capability.slice(0, -1))));
}

const action = z.enum(["auto", "ask", "deny"]);
export function settingsAction(value: string): z.infer<typeof action> {
  return action.parse(value);
}
export const settingsPolicySchema = z.strictObject({
  default: action,
  rules: z.array(z.strictObject({
    match: z.string().min(1).refine((value) => value.trim() === value, "Remove surrounding spaces"),
    target: z.string().min(1).optional(),
    action,
  })),
});
export type SettingsPolicy = z.infer<typeof settingsPolicySchema>;

export function readSettingsPolicy(value: string): SettingsPolicy | null {
  try {
    const result = settingsPolicySchema.safeParse(JSON.parse(value));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function instructionPath(name: string): string {
  if (!name.endsWith(".md") || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error("Select a Markdown file from your instructions folder");
  }
  return `~/context.d/${name}`;
}

export function newInstructionName(value: string): string {
  const stem = value.trim().replace(/\.md$/i, "");
  if (!stem.trim() || stem === "." || stem === ".." || /[\x00-\x1f\x7f]/.test(stem)) {
    throw new Error("Give your instruction a file name");
  }
  const name = `${stem}.md`;
  if (name.includes("/") || name.includes("\\")) throw new Error("Use a file name without folders");
  instructionPath(name);
  return name;
}

export function signInUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
