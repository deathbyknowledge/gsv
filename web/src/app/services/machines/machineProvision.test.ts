import { describe, expect, it } from "vitest";
import { buildMachineInstallCommand, machineDeviceIdFromName } from "./machineProvision";
import { browserExtensionDownloadUrl } from "../../domain/cliInstall";
import { DEVICE_ID_MAX_LENGTH, parseDeviceId } from "../../domain/deviceId";

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

  it("uses the gateway release for the extension download", () => {
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

});
