import { describe, expect, it } from "vitest";
import {
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
import { browserExtensionDownloadUrl } from "../../../domain/cliInstall";
import { DEVICE_ID_MAX_LENGTH, parseDeviceId } from "../../../domain/deviceId";

describe("machineProvision", () => {
  it("normalizes display names into stable device ids", () => {
    expect(machineDeviceIdFromName("Studio MacBook Pro")).toBe("studio-macbook-pro");
    expect(machineDeviceIdFromName("  Server_01  ")).toBe("server_01");
    expect(machineDeviceIdFromName("!!!")).toBe("machine");
  });

  it("accepts only narrow shell-safe device ids", () => {
    expect(parseDeviceId(" node_01 ")).toBe("node_01");
    expect(parseDeviceId("Node-01")).toBeNull();
    expect(parseDeviceId("node-$(whoami)")).toBeNull();
    expect(parseDeviceId(`n${"x".repeat(DEVICE_ID_MAX_LENGTH)}`)).toBeNull();
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
    expect(browserExtensionDownloadUrl("v0.4.0")).toBe(
      "https://github.com/deathbyknowledge/gsv/releases/download/v0.4.0/gsv-browser-extension.zip",
    );
    expect(browserExtensionDownloadUrl("dev")).toBe(
      "https://github.com/deathbyknowledge/gsv/releases/download/dev/gsv-browser-extension.zip",
    );
    expect(browserExtensionDownloadUrl("unexpected")).toBe(
      "https://github.com/deathbyknowledge/gsv/releases/download/dev/gsv-browser-extension.zip",
    );
  });

  it("builds canonical install commands for the gateway release", () => {
    expect(buildMachineInstallCommand("linux", "v0.4.0")).toBe(
      "curl -fsSL https://install.gsv.space | GSV_VERSION=v0.4.0 bash",
    );
    expect(buildMachineInstallCommand("windows", "dev")).toBe(
      "$env:GSV_CHANNEL='dev'; irm https://install.gsv.space/install.ps1 | iex",
    );
    expect(buildMachineInstallCommand("browser", "dev")).toBe("");
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

  it("refuses unsafe device ids in generated commands", () => {
    expect(() => buildMachineBootstrapCommand({
      origin: "https://gsv.example.com",
      platform: "linux",
      username: "hank",
      deviceId: "node-$(whoami)",
      token: "tok",
    })).toThrow("Invalid device ID");
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
