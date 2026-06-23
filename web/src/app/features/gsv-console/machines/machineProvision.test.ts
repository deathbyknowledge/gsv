import { describe, expect, it } from "vitest";
import {
  buildMachineBootstrapCommand,
  buildMachineInstallCommand,
  expiresAtFromDays,
  machineDeviceIdFromName,
  normalizeExpiresDays,
} from "./machineProvision";

describe("machineProvision", () => {
  it("normalizes display names into stable device ids", () => {
    expect(machineDeviceIdFromName("Studio MacBook Pro")).toBe("studio-macbook-pro");
    expect(machineDeviceIdFromName("  Server_01  ")).toBe("server_01");
    expect(machineDeviceIdFromName("!!!")).toBe("machine");
  });

  it("builds platform install commands from the web origin", () => {
    expect(buildMachineInstallCommand("https://gsv.example.com/", "linux")).toBe(
      "curl -fsSL https://gsv.example.com/public/gsv/downloads/cli/install.sh | bash -s -- https://gsv.example.com",
    );
    expect(buildMachineInstallCommand("https://gsv.example.com", "windows")).toBe(
      "$env:GSV_BASE_URL='https://gsv.example.com'; irm https://gsv.example.com/public/gsv/downloads/cli/install.ps1 | iex",
    );
  });

  it("builds bootstrap commands with websocket gateway config", () => {
    expect(buildMachineBootstrapCommand({
      origin: "https://gsv.example.com",
      platform: "mac",
      username: "hank",
      deviceId: "studio-mac",
      token: "tok\"en",
    })).toBe([
      "gsv config --local set gateway.url \"wss://gsv.example.com/ws\"",
      "gsv config --local set gateway.username \"hank\"",
      "gsv config --local set node.token \"tok\\\"en\"",
      "gsv device install --id \"studio-mac\" --workspace ~/",
    ].join("\n"));
  });

  it("bounds token expiry days", () => {
    expect(normalizeExpiresDays("")).toBe(30);
    expect(normalizeExpiresDays("-5")).toBe(30);
    expect(normalizeExpiresDays("400")).toBe(365);
    expect(expiresAtFromDays(7, 1_000)).toBe(1_000 + 7 * 24 * 60 * 60 * 1000);
  });
});
