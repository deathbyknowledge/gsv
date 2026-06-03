import type { PromptContextProvider } from "../types";

const MAX_RENDERED_TARGETS = 5;

export function createSystemContextProvider(): PromptContextProvider {
  return {
    name: "system.context",
    async collect(input) {
      return renderContextFiles("system.context", input.config.systemContextFiles, input);
    },
  };
}

function renderContextFiles(
  sectionPrefix: string,
  files: Array<{ name: string; text: string }> | undefined,
  input: Parameters<typeof renderContextTemplate>[1],
): Array<{ name: string; text: string }> {
  return [...(files ?? [])]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((file) => {
      const text = renderContextTemplate(file.text, input).trim();
      if (!text) {
        return null;
      }
      return {
        name: `${sectionPrefix}:${file.name}`,
        text,
      };
    })
    .filter((section): section is { name: string; text: string } => section !== null);
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
  },
): string {
  const user = input.ownerIdentity ?? input.identity;
  const values = new Map<string, string>([
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
    ["devices", formatDevices(input.devices)],
    ["mcpServers", formatMcpServers(input.mcpServers)],
  ]);

  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, key: string) => {
    return values.get(key) ?? "";
  });
}

function formatDevices(
  devices: Array<{ id: string; label?: string; implements: string[]; description?: string; platform?: string }>,
): string {
  if (devices.length === 0) {
    return "- gsv";
  }
  const sortedDevices = [...devices].sort((left, right) => left.id.localeCompare(right.id));
  const renderedDevices = sortedDevices.slice(0, MAX_RENDERED_TARGETS);
  const remaining = sortedDevices.length - renderedDevices.length;
  const lines = [
    "- gsv",
    ...renderedDevices.map(formatDeviceLine),
  ];
  if (remaining > 0) {
    lines.push(`- ... ${remaining} more ${remaining === 1 ? "target" : "targets"}. Run \`targets list\` in Shell to discover more.`);
  }
  return lines.join("\n");
}

function formatDeviceLine(device: {
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
