import { describe, expect, it } from "vitest";
import {
  BROWSER_EXTENSION_DOWNLOAD_URL,
  MACHINE_PLATFORM_OPTIONS,
  buildBrowserExtensionConfig,
  buildMachineBootstrapCommand,
  buildMachineInstallCommand,
  buildMachineRunCommand,
  defaultMachineName,
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

  it("uses a short browser target id by default", () => {
    expect(defaultMachineName("browser")).toBe("Chrome");
    expect(machineDeviceIdFromName(defaultMachineName("browser"))).toBe("chrome");
  });

  it("presents browser as an extension target", () => {
    expect(MACHINE_PLATFORM_OPTIONS.find((option) => option.id === "browser")).toMatchObject({
      meta: "Browser extension",
      dotIcon: "chrome",
    });
    expect(BROWSER_EXTENSION_DOWNLOAD_URL).toContain("gsv-browser-extension.zip");
  });

  it("builds platform install commands from the web origin", () => {
    expect(buildMachineInstallCommand("https://gsv.example.com/", "linux")).toBe(
      "curl -fsSL https://gsv.example.com/public/gsv/downloads/cli/install.sh | bash -s -- https://gsv.example.com",
    );
    expect(buildMachineInstallCommand("https://gsv.example.com", "windows")).toBe(
      "$env:GSV_BASE_URL='https://gsv.example.com'; irm https://gsv.example.com/public/gsv/downloads/cli/install.ps1 | iex",
    );
    expect(buildMachineInstallCommand("https://gsv.example.com", "browser")).toBe("");
  });

  it("builds browser extension option values", () => {
    expect(buildBrowserExtensionConfig({
      origin: "https://gsv.example.com",
      username: " hank ",
      deviceId: " chrome ",
      token: " gsv_node_secret ",
    })).toEqual({
      gatewayUrl: "wss://gsv.example.com/ws",
      username: "hank",
      token: "gsv_node_secret",
      deviceId: "chrome",
    });
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

  it("uses the Windows executable name in bootstrap commands", () => {
    expect(buildMachineBootstrapCommand({
      origin: "https://gsv.example.com",
      platform: "windows",
      username: "hank",
      deviceId: "studio-pc",
      token: "tok",
    })).toBe([
      "gsv.exe config --local set gateway.url \"wss://gsv.example.com/ws\"",
      "gsv.exe config --local set gateway.username \"hank\"",
      "gsv.exe config --local set node.token \"tok\"",
      "gsv.exe device install --id \"studio-pc\" --workspace \"$HOME\"",
    ].join("\n"));
  });

  it("builds one-shot foreground device run commands", () => {
    expect(buildMachineRunCommand({
      origin: "http://localhost:8788/",
      platform: "linux",
      username: "hank",
      deviceId: "dev-machine",
      token: "tok\"en",
    })).toBe(
      "gsv --url \"ws://localhost:8788/ws\" --user \"hank\" --token \"tok\\\"en\" device run --id \"dev-machine\" --workspace ~/",
    );
    expect(buildMachineRunCommand({
      origin: "https://gsv.example.com",
      platform: "windows",
      username: "hank",
      deviceId: "windows-dev",
      token: "secret",
    })).toBe(
      "gsv.exe --url \"wss://gsv.example.com/ws\" --user \"hank\" --token \"secret\" device run --id \"windows-dev\" --workspace \"$HOME\"",
    );
  });

  it("bounds token expiry days", () => {
    expect(normalizeExpiresDays("")).toBe(30);
    expect(normalizeExpiresDays("-5")).toBe(30);
    expect(normalizeExpiresDays("400")).toBe(365);
    expect(expiresAtFromDays(7, 1_000)).toBe(1_000 + 7 * 24 * 60 * 60 * 1000);
  });
});
