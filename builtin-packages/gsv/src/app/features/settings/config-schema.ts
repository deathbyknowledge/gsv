import type { ConfigSection, ProfileId, SettingField } from "./types";

export const CONFIG_SECTIONS: ConfigSection[] = [
  {
    id: "ai",
    panel: "ai",
    label: "AI defaults",
    description: "Provider, model, reasoning, and prompt budget defaults.",
  },
  {
    id: "profiles",
    panel: "profiles",
    label: "Profiles",
    description: "Profile context blocks and tool approval policies.",
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
  {
    id: "processes",
    panel: "runtime",
    label: "Processes",
    description: "Process naming and concurrency controls.",
  },
  {
    id: "automation",
    panel: "runtime",
    label: "Automation",
    description: "Background archivist and curator scheduling.",
  },
];

export const PROFILE_OPTIONS: Array<{ id: ProfileId; label: string; description: string }> = [
  { id: "init", label: "Init", description: "Persistent system coordinator." },
  { id: "mind", label: "GSV Mind", description: "Internal social and cross-process coordinator." },
  { id: "task", label: "Task", description: "Primary interactive task runner." },
  { id: "review", label: "Review", description: "Package and code review specialist." },
  { id: "cron", label: "Cron", description: "Scheduled background work." },
  { id: "mcp", label: "MCP", description: "Operational control and diagnosis." },
  { id: "app", label: "App", description: "App-owned runtime processes." },
  { id: "archivist", label: "Archivist", description: "Workspace continuity compaction." },
  { id: "curator", label: "Curator", description: "Inbox candidate review and promotion." },
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
    description: "Maximum bytes of workspace context injected into prompts.",
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

export const PROCESS_FIELDS: SettingField[] = [
  {
    key: "config/process/init_label",
    label: "Init label template",
    description: "Label template for init processes. {username} is substituted at runtime.",
    kind: "text",
  },
  {
    key: "config/process/max_per_user",
    label: "Max processes per user",
    description: "Concurrent process limit per user. Use 0 for unlimited.",
    kind: "number",
  },
];

export const AUTOMATION_FIELDS: SettingField[] = [
  {
    key: "config/automation/archivist/min_interval_ms",
    label: "Archivist minimum interval (ms)",
    description: "Minimum time between archivist jobs for the same scope.",
    kind: "number",
  },
  {
    key: "config/automation/curator/interval_ms",
    label: "Curator interval (ms)",
    description: "Periodic curator sweep interval. Use 0 to disable periodic runs.",
    kind: "number",
  },
  {
    key: "config/automation/curator/batch_size",
    label: "Curator batch size",
    description: "Maximum inbox candidates reviewed in a single sweep.",
    kind: "number",
  },
];

export const PROFILE_CONTEXT_FIELDS: Array<{ file: string; label: string; description: string; rows: number }> = [
  {
    file: "00-role.md",
    label: "Role context",
    description: "Primary responsibility and behavioral framing for the selected profile.",
    rows: 7,
  },
  {
    file: "10-runtime.md",
    label: "Runtime context",
    description: "Runtime facts injected into the prompt, such as cwd, workspace, and devices.",
    rows: 8,
  },
  {
    file: "20-tooling.md",
    label: "Tooling context",
    description: "Tool usage rules and workflow guidance specific to the selected profile.",
    rows: 9,
  },
];

export function buildProfileContextKey(profile: ProfileId, file: string): string {
  return `config/ai/profile/${profile}/context.d/${file}`;
}

export function buildProfileApprovalKey(profile: ProfileId): string {
  return `config/ai/profile/${profile}/tools/approval`;
}

export function buildUserAiOverrideKey(uid: number, systemKey: string): string {
  if (!systemKey.startsWith("config/ai/")) {
    throw new Error(`Cannot build user AI override for non-AI key: ${systemKey}`);
  }
  return `users/${uid}/${systemKey.slice("config/".length)}`;
}
