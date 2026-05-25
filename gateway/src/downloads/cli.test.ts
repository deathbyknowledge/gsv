import { describe, expect, it } from "vitest";
import {
  buildCliInstallPowerShell,
  buildCliInstallScript,
  cliAssetKey,
  cliChecksumKey,
  cliGithubReleaseAssetUrl,
  inferDefaultCliChannel,
} from "./cli";

describe("CLI release helpers", () => {
  it("infers stable channel for mainline refs", () => {
    expect(inferDefaultCliChannel("release/0.1")).toBe("stable");
  });

  it("infers dev channel for feature refs", () => {
    expect(inferDefaultCliChannel("main")).toBe("dev");
  });

  it("stores mirrored CLI assets under the public filesystem root", () => {
    expect(cliAssetKey("dev", "gsv-linux-x64")).toBe(
      "public/gsv/downloads/cli/dev/gsv-linux-x64",
    );
    expect(cliChecksumKey("stable", "gsv-darwin-arm64")).toBe(
      "public/gsv/downloads/cli/stable/gsv-darwin-arm64.sha256",
    );
  });

  it("builds direct GitHub release asset URLs without the releases API", () => {
    expect(cliGithubReleaseAssetUrl("stable", "gsv-linux-x64")).toBe(
      "https://github.com/deathbyknowledge/gsv/releases/latest/download/gsv-linux-x64",
    );
    expect(cliGithubReleaseAssetUrl("dev", "gsv-linux-x64")).toMatch(
      /^https:\/\/github\.com\/deathbyknowledge\/gsv\/releases\/download\/dev\/gsv-linux-x64\?ts=\d+$/,
    );
  });

  it("builds a windows installer script for the mirrored x64 asset", () => {
    const script = buildCliInstallPowerShell();
    expect(script).toContain("$BinaryName = 'gsv-windows-x64.exe'");
    expect(script).toContain("/public/gsv/downloads/cli");
    expect(script).toContain("Using the Windows x64 CLI build on ARM64.");
  });

  it("builds a static shell installer script that expects the GSV origin", () => {
    const script = buildCliInstallScript();
    expect(script).toContain("BASE_ORIGIN=\"${1:-${GSV_BASE_URL:-}}\"");
    expect(script).toContain("/public/gsv/downloads/cli");
    expect(script).toContain("default-channel.txt");
  });
});
