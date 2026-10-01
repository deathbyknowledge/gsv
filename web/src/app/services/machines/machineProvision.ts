import { buildCliInstallCommand } from "../../domain/cliInstall";
export { machineDeviceIdFromName } from "@humansandmachines/gsv/device-setup";

export type MachineProvisionPlatform = "mac" | "windows" | "linux" | "browser";

export function buildMachineInstallCommand(platform: MachineProvisionPlatform, release: string): string {
  if (platform === "browser") {
    return "";
  }
  return buildCliInstallCommand(platform === "windows" ? "windows" : "unix", release);
}
