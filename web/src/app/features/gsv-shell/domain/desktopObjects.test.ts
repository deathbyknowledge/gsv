import { describe, expect, it } from "vitest";
import type {
  ConsoleAdapter,
  ConsoleAdapterAccount,
  ConsoleMcpServer,
  ConsoleOverviewData,
  ConsolePackage,
  ConsoleTarget,
} from "../../gsv-console/domain/consoleModels";
import { buildDesktopObjectsFromConsole } from "./desktopObjects";
import { shellTabForDesktopChild } from "./shellModel";

const target: ConsoleTarget = {
  deviceId: "hank-linux",
  kind: "native-device",
  ownerUid: 1,
  ownerUsername: "hank",
  label: "Hank Linux",
  description: "Primary compute host",
  platform: "linux",
  version: "6.8",
  online: true,
  lastSeenAt: 1_700_000_000,
  implements: ["shell.exec", "fs.read"],
};

const adapter: ConsoleAdapterAccount = {
  adapter: "discord",
  accountId: "crew",
  connected: true,
  authenticated: true,
  mode: "bot",
  lastActivity: 1_700_000_100,
  error: "",
  extra: {},
};

const adapterInventory: ConsoleAdapter = {
  adapter: "discord",
  available: true,
  supportsConnect: true,
  supportsDisconnect: true,
  supportsSend: true,
  supportsStatus: true,
  supportsShellExec: true,
  supportsActivity: true,
  accounts: [adapter],
};

const appPackage: ConsolePackage = {
  packageId: "space-simulation",
  name: "Space Simulation",
  description: "Orbital sim",
  version: "1.0.0",
  runtime: "web-ui",
  enabled: true,
  scopeKind: "global",
  scopeUid: null,
  sourceRepo: "gsv/space-simulation",
  sourceRef: "main",
  sourceSubdir: "",
  sourcePublic: true,
  reviewRequired: false,
  reviewApprovedAt: null,
  reviewPending: false,
  installedAt: 1_700_000_000,
  updatedAt: 1_700_000_000,
  bindingNames: [],
  entrypoints: [{
    name: "main",
    kind: "ui",
    description: "Main app",
    route: "/apps/space-simulation/",
    command: "",
    syscalls: [],
  }],
  uiEntrypoints: [{
    name: "main",
    kind: "ui",
    description: "Main app",
    route: "/apps/space-simulation/",
    command: "",
    syscalls: [],
  }],
};

const integrationPackage: ConsolePackage = {
  ...appPackage,
  packageId: "custom-mcp",
  name: "Custom MCP",
  runtime: "dynamic-worker",
  sourceRepo: "gsv/custom-mcp",
  entrypoints: [],
  uiEntrypoints: [],
};

const mcpServer: ConsoleMcpServer = {
  serverId: "custom-mcp",
  uid: 1,
  name: "Custom MCP",
  url: "https://mcp.example.com/mcp",
  transport: "streamable-http",
  state: "ready",
  authUrl: "",
  error: "",
  instructions: "",
  capabilities: null,
  tools: [],
  resourceCount: 0,
  promptCount: 0,
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_100,
};

const nativePackage: ConsolePackage = {
  ...appPackage,
  packageId: "@gsv/chat",
  name: "@gsv/chat",
  description: "Native chat shell surface",
  sourceRepo: "gsv/chat",
};

const overview: ConsoleOverviewData = {
  loadedAt: 1_700_000_200,
  processes: [],
  targets: [target],
  packages: [appPackage, integrationPackage, nativePackage],
  accounts: [],
  adapterInventory: [adapterInventory],
  adapters: [adapter],
  mcpServers: [mcpServer],
  config: [],
};

describe("buildDesktopObjectsFromConsole", () => {
  it("keeps raw detail route IDs for desktop children", () => {
    const objects = buildDesktopObjectsFromConsole(overview);

    expect(objects.find((object) => object.id === "machines")?.children[0]?.route).toEqual({
      kind: "machines",
      detailId: "hank-linux",
    });
    expect(objects.find((object) => object.id === "messengers")?.children).toHaveLength(2);
    expect(objects.find((object) => object.id === "messengers")?.children[0]?.route).toEqual({
      kind: "messengers",
      detailId: "telegram",
    });
    expect(objects.find((object) => object.id === "messengers")?.children[1]?.route).toEqual({
      kind: "messengers",
      detailId: "discord",
    });
    expect(objects.find((object) => object.id === "messengers")?.children[0]?.statusLabel).toBe("NOT ENABLED");
    expect(objects.find((object) => object.id === "messengers")?.children[1]?.statusLabel).toBe("CONNECTED");
    expect(objects.find((object) => object.id === "integrations")?.children[0]?.route).toEqual({
      kind: "integrations",
      detailId: "custom-mcp",
    });
    expect(objects.find((object) => object.id === "applications")?.children[0]?.route).toEqual({
      kind: "applications",
      detailId: "space-simulation",
    });
    expect(objects.find((object) => object.id === "applications")?.children[0]?.appRoute).toEqual({
      appId: "Space Simulation",
      suffix: "/",
      search: "",
      hash: "",
    });
    expect(objects.find((object) => object.id === "applications")?.children).toHaveLength(1);
    expect(objects.find((object) => object.id === "integrations")?.children).toHaveLength(1);
  });
});

describe("shellTabForDesktopChild", () => {
  it("opens object tabs through the settings detail route", () => {
    const child = buildDesktopObjectsFromConsole(overview)
      .find((object) => object.id === "machines")
      ?.children[0];

    expect(child).toBeDefined();
    const tab = shellTabForDesktopChild(child!);

    expect(tab).toMatchObject({
      key: "obj:machines:hank-linux",
      surface: "settings",
      title: "Hank Linux",
      kind: "object",
      icon: "computer",
      settingsRoute: {
        view: "list",
        kind: "machines",
        detailId: "hank-linux",
      },
    });
  });
});
