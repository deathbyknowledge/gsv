import { describe, expect, it } from "vitest";
import type {
  ConsoleAdapter,
  ConsoleAdapterAccount,
  ConsoleMcpServer,
  ConsoleOverviewData,
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
  supportsActivity: true,
  supportsPairing: false,
  accounts: [adapter],
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

const overview: ConsoleOverviewData = {
  loadedAt: 1_700_000_200,
  processes: [],
  targets: [target],
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
    expect(objects.find((object) => object.id === "messengers")?.children).toHaveLength(4);
    expect(objects.find((object) => object.id === "messengers")?.children[0]?.route).toEqual({
      kind: "messengers",
      detailId: "telegram",
    });
    expect(objects.find((object) => object.id === "messengers")?.children[1]?.route).toEqual({
      kind: "messengers",
      detailId: "slack",
    });
    expect(objects.find((object) => object.id === "messengers")?.children[2]?.route).toEqual({
      kind: "messengers",
      detailId: "discord",
    });
    expect(objects.find((object) => object.id === "messengers")?.children[3]?.route).toEqual({
      kind: "messengers",
      detailId: "whatsapp",
    });
    expect(objects.find((object) => object.id === "messengers")?.children[0]?.statusLabel).toBe("UNAVAILABLE");
    expect(objects.find((object) => object.id === "messengers")?.children[1]?.statusLabel).toBe("UNAVAILABLE");
    expect(objects.find((object) => object.id === "messengers")?.children[2]?.statusLabel).toBe("CONNECTED");
    expect(objects.find((object) => object.id === "messengers")?.children[3]).toMatchObject({
      statusLabel: "UNAVAILABLE",
      blurb: expect.stringContaining("deploy it"),
    });
    expect(objects.find((object) => object.id === "integrations")?.children[0]?.route).toEqual({
      kind: "integrations",
      detailId: "custom-mcp",
    });
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
