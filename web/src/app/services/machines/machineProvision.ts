import { buildCliInstallCommand } from "../../domain/cliInstall";
import { DEVICE_ID_MAX_LENGTH } from "../../domain/deviceId";

export type MachineProvisionPlatform = "mac" | "windows" | "linux" | "browser";

export function machineDeviceIdFromName(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, DEVICE_ID_MAX_LENGTH);

  return base || "machine";
}

export function buildMachineInstallCommand(platform: MachineProvisionPlatform, release: string): string {
  if (platform === "browser") {
    return "";
  }
  return buildCliInstallCommand(platform === "windows" ? "windows" : "unix", release);
}
