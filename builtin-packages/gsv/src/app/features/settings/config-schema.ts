import type { ConfigSection, SettingField } from "./types";

export const CONFIG_SECTIONS: ConfigSection[] = [
  {
    id: "ai",
    panel: "ai",
    label: "AI defaults",
    description: "Provider, model, reasoning, and prompt budget defaults.",
  },
  {
    id: "shell",
    panel: "runtime",
    label: "Shell",
    description: "Native command execution limits and network behavior.",
  },
  {
    id: "server",
    panel: "runtime",
    label: "Server",
    description: "Instance identity and runtime metadata.",
  },
];

export const AI_FIELDS: SettingField[] = [
  {
    key: "config/ai/provider",
    label: "Provider",
    description: "LLM provider used for system-owned runs and default inference routing.",
    kind: "text",
    placeholder: "workers-ai",
  },
  {
    key: "config/ai/model",
    label: "Model",
    description: "Model identifier passed to the selected provider.",
    kind: "text",
    placeholder: "@cf/nvidia/nemotron-3-120b-a12b",
  },
  {
    key: "config/ai/api_key",
    label: "API key",
    description: "Provider API key. Leave empty for local or built-in providers when valid.",
    kind: "password",
  },
  {
    key: "config/ai/reasoning",
    label: "Reasoning mode",
    description: "Reasoning effort hint for models that support extended thinking.",
    kind: "select",
    options: [
      { value: "off", label: "Off" },
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ],
  },
  {
    key: "config/ai/max_tokens",
    label: "Max tokens",
    description: "Upper bound for generated response size.",
    kind: "number",
  },
  {
    key: "config/ai/max_context_bytes",
    label: "Max context bytes",
    description: "Maximum bytes of home context injected into prompts.",
    kind: "number",
  },
];

export const SHELL_FIELDS: SettingField[] = [
  {
    key: "config/shell/timeout_ms",
    label: "Timeout (ms)",
    description: "Default timeout for native shell execution.",
    kind: "number",
  },
  {
    key: "config/shell/network_enabled",
    label: "Network enabled",
    description: "Allow network-capable shell tools such as curl and wget.",
    kind: "checkbox",
  },
  {
    key: "config/shell/max_output_bytes",
    label: "Max output bytes",
    description: "Maximum captured shell output before truncation.",
    kind: "number",
  },
];

export const SERVER_FIELDS: SettingField[] = [
  {
    key: "config/server/name",
    label: "Instance name",
    description: "Human-readable name shown by system tools and shell surfaces.",
    kind: "text",
  },
  {
    key: "config/server/timezone",
    label: "Timezone",
    description: "IANA timezone used for scheduling and timestamps.",
    kind: "text",
    placeholder: "Europe/Amsterdam",
  },
  {
    key: "config/server/version",
    label: "Version",
    description: "Current server version reported by the runtime.",
    kind: "readonly",
  },
];

export function buildUserAiOverrideKey(uid: number, systemKey: string): string {
  if (!systemKey.startsWith("config/ai/")) {
    throw new Error(`Cannot build user AI override for non-AI key: ${systemKey}`);
  }
  return `users/${uid}/${systemKey.slice("config/".length)}`;
}
