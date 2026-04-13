import type { PromptContextProvider } from "../types";

export function createProfileInstructionsProvider(): PromptContextProvider {
  return {
    name: "profile.context",
    async collect(input) {
      return [...(input.config.profileContextFiles ?? [])]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((file) => {
          const text = renderProfileTemplate(file.text, input).trim();
          if (!text) {
            return null;
          }
          return {
            name: `profile.context:${file.name}`,
            text,
          };
        })
        .filter((section): section is { name: string; text: string } => section !== null);
    },
  };
}

function renderProfileTemplate(
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
    devices: Array<{ id: string; implements: string[]; platform?: string }>;
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
    ["known_paths", formatKnownPaths(input.identity.home)],
  ]);

  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, key: string) => {
    return values.get(key) ?? "";
  });
}

function formatDevices(
  devices: Array<{ id: string; implements: string[]; platform?: string }>,
): string {
  if (devices.length === 0) {
    return "- gsv: control plane and local execution target";
  }
  const lines = [
    "- gsv: control plane and local execution target",
    ...[...devices]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((device) => {
        const parts = [device.id];
        if (device.platform) {
          parts.push(device.platform);
        }
        // if (device.implements.length > 0) {
        //   parts.push(`implements ${device.implements.join(", ")}`);
        // }
        return `- ${parts.join(" — ")}`;
      }),
  ];
  return lines.join("\n");
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
