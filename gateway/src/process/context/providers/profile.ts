import type { PromptContextProvider } from "../types";

export function createSystemContextProvider(): PromptContextProvider {
  return {
    name: "system.context",
    async collect(input) {
      return renderContextFiles("system.context", input.config.systemContextFiles, input);
    },
  };
}

export function createProfileInstructionsProvider(): PromptContextProvider {
  return {
    name: "profile.context",
    async collect(input) {
      return renderContextFiles("profile.context", input.config.profileContextFiles, input);
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
    profile: string;
    identity: {
      uid: number;
      gid: number;
      username: string;
      home: string;
      cwd: string;
      workspaceId: string | null;
    };
    devices: Array<{ id: string; implements: string[]; description?: string; platform?: string }>;
    mcpServers: string[];
  },
): string {
  const values = new Map<string, string>([
    ["profile", input.profile],
    ["identity.uid", String(input.identity.uid)],
    ["identity.gid", String(input.identity.gid)],
    ["identity.username", input.identity.username],
    ["identity.home", input.identity.home],
    ["identity.cwd", input.identity.cwd],
    ["identity.workspaceId", input.identity.workspaceId ?? ""],
    ["workspace", input.identity.workspaceId ? `/workspaces/${input.identity.workspaceId}` : "(none)"],
    ["devices", formatDevices(input.devices)],
    ["mcpServers", formatMcpServers(input.mcpServers)],
    ["known_paths", formatKnownPaths(input.identity.home)],
  ]);

  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, key: string) => {
    return values.get(key) ?? "";
  });
}

function formatDevices(
  devices: Array<{ id: string; implements: string[]; description?: string; platform?: string }>,
): string {
  if (devices.length === 0) {
    return "- gsv";
  }
  const lines = [
    "- gsv",
    ...[...devices]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((device) => {
        const description = device.description?.trim();
        if (description && device.platform) {
          return `- ${device.id}: ${description} (${device.platform})`;
        }
        if (description) {
          return `- ${device.id}: ${description}`;
        }
        if (device.platform) {
          return `- ${device.id}: ${device.platform}`;
        }
        return `- ${device.id}`;
      }),
  ];
  return lines.join("\n");
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

function formatKnownPaths(home: string): string {
  return [
    `- ${home}: the user's home, including standing context and durable knowledge`,
    "- /workspaces: task workspaces and user artifacts",
    "- /var: runtime-managed state, caches, and generated system data",
    "- /etc: system manuals and stable operator documentation",
    "- /sys: live kernel configuration and runtime control surfaces",
    "- /proc: live process and runtime inspection surfaces",
    "- /dev: device-like virtual endpoints",
  ].join("\n");
}
