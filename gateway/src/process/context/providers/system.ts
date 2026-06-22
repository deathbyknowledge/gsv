import type { PromptContextProvider, PromptSection } from "../types";

const MAX_RENDERED_TARGETS = 5;

export function createSystemContextProvider(): PromptContextProvider {
  return {
    name: "system.context",
    async collect(input) {
      return renderContextFiles(input.config.systemContextFiles, input);
    },
  };
}

function renderContextFiles(
  files: Array<{ name: string; text: string }> | undefined,
  input: Parameters<typeof renderContextTemplate>[1],
): PromptSection[] {
  return [...(files ?? [])]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((file): PromptSection | null => {
      const text = renderContextTemplate(file.text, input).trim();
      if (!text) {
        return null;
      }
      return {
        name: file.name,
        text,
        contextRoot: {
          key: "system",
          label: "SYSTEM",
          access: "read-only",
          location: "/sys/config/ai/context.d",
        },
      };
    })
    .filter((section): section is PromptSection => section !== null);
}

function renderContextTemplate(
  template: string,
  input: {
    identity: {
      uid: number;
      gid: number;
      username: string;
      home: string;
      cwd: string;
    };
    ownerIdentity?: {
      uid: number;
      gid: number;
      username: string;
      home: string;
      cwd: string;
    };
    devices: Array<{ id: string; label?: string; implements: string[]; description?: string; platform?: string }>;
    mcpServers: string[];
    config: {
      system?: {
        timezone?: string;
      };
    };
  },
): string {
  const user = input.ownerIdentity ?? input.identity;
  const timezone = normalizeTimezone(input.config.system?.timezone);
  const values = new Map<string, string>([
    ["current.date", formatCurrentDate(timezone)],
    ["current.timezone", timezone],
    ["identity.uid", String(input.identity.uid)],
    ["identity.gid", String(input.identity.gid)],
    ["identity.username", input.identity.username],
    ["identity.home", input.identity.home],
    ["identity.cwd", input.identity.cwd],
    ["program.uid", String(input.identity.uid)],
    ["program.gid", String(input.identity.gid)],
    ["program.username", input.identity.username],
    ["program.home", input.identity.home],
    ["program.cwd", input.identity.cwd],
    ["owner.uid", String(user.uid)],
    ["owner.gid", String(user.gid)],
    ["owner.username", user.username],
    ["owner.home", user.home],
    ["owner.cwd", user.cwd],
    ["user.uid", String(user.uid)],
    ["user.gid", String(user.gid)],
    ["user.username", user.username],
    ["user.home", user.home],
    ["user.cwd", user.cwd],
    ["targets", formatTargets(input.devices)],
    ["devices", formatTargets(input.devices)],
    ["mcpServers", formatMcpServers(input.mcpServers)],
  ]);

  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, key: string) => {
    return values.get(key) ?? "";
  });
}

function normalizeTimezone(timezone: string | undefined): string {
  const candidate = typeof timezone === "string" && timezone.trim() ? timezone.trim() : "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return "UTC";
  }
}

function formatCurrentDate(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function formatTargets(
  devices: Array<{ id: string; label?: string; implements: string[]; description?: string; platform?: string }>,
): string {
  if (devices.length === 0) {
    return "- gsv";
  }
  const sortedTargets = [...devices].sort((left, right) => left.id.localeCompare(right.id));
  const renderedTargets = sortedTargets.slice(0, MAX_RENDERED_TARGETS);
  const remaining = sortedTargets.length - renderedTargets.length;
  const lines = [
    "- gsv",
    ...renderedTargets.map(formatTargetLine),
  ];
  if (remaining > 0) {
    lines.push(`- ... ${remaining} more ${remaining === 1 ? "target" : "targets"}. Run \`targets list\` in Shell to discover more.`);
  }
  return lines.join("\n");
}

function formatTargetLine(device: {
  id: string;
  label?: string;
  description?: string;
  platform?: string;
}): string {
  const label = device.label?.trim();
  const description = device.description?.trim();
  const platform = device.platform?.trim();
  const name = label && label !== device.id ? `${device.id}: ${label}` : device.id;
  if (description && platform) {
    return `- ${name} - ${description} (${platform})`;
  }
  if (description) {
    return `- ${name} - ${description}`;
  }
  if (platform) {
    return `- ${name} (${platform})`;
  }
  return `- ${name}`;
}

function formatMcpServers(mcpServers: string[]): string {
  if (mcpServers.length === 0) {
    return "- (none)";
  }
  return [...new Set(mcpServers)]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => `- ${name}`)
    .join("\n");
}
