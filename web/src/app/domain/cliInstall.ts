export {
  browserExtensionDownloadUrl, cliReleaseLabel, LATEST_RELEASE_PAGE_URL,
  type CliInstallPlatform,
} from "@humansandmachines/gsv/device-setup";
import { buildCliInstallCommand as installCommand, type CliInstallPlatform } from "@humansandmachines/gsv/device-setup";
import { publicDeployment } from "../services/deployment";

export function buildCliInstallCommand(platform: CliInstallPlatform, release: string): string {
  return installCommand(platform, release, publicDeployment().installUrl);
}
