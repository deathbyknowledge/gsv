import { describe, expect, it } from "vitest";
import {
  buildCliInstallPowerShell,
  inferDefaultCliChannel,
  isSupportedCliAsset,
  isSemverCliPrereleaseTag,
  isSemverCliReleaseTag,
  selectLatestCliPrereleaseTag,
} from "./cli";

describe("CLI release helpers", () => {
  it("infers stable channel for mainline refs", () => {
    expect(inferDefaultCliChannel("release/0.1")).toBe("stable");
  });

  it("infers dev channel for feature refs", () => {
    expect(inferDefaultCliChannel("main")).toBe("dev");
  });

  it("recognizes semver release tags", () => {
    expect(isSemverCliReleaseTag("v0.1.0")).toBe(true);
    expect(isSemverCliReleaseTag("v0.1.0-dev.12")).toBe(true);
    expect(isSemverCliReleaseTag("0.1.0")).toBe(false);
    expect(isSemverCliReleaseTag("stable")).toBe(false);
  });

  it("distinguishes prerelease tags", () => {
    expect(isSemverCliPrereleaseTag("v0.1.0")).toBe(false);
    expect(isSemverCliPrereleaseTag("v0.1.0-dev.12")).toBe(true);
  });

  it("selects the latest prerelease tag from GitHub releases", () => {
    const tag = selectLatestCliPrereleaseTag([
      { tag_name: "v0.2.0-dev.42", prerelease: true, draft: false },
      { tag_name: "v0.2.0-dev.41", prerelease: true, draft: false },
    ]);
    expect(tag).toBe("v0.2.0-dev.42");
  });

  it("skips drafts and non-semver prereleases", () => {
    const tag = selectLatestCliPrereleaseTag([
      { tag_name: "dev", prerelease: true, draft: false },
      { tag_name: "v0.2.0-dev.43", prerelease: true, draft: true },
      { tag_name: "v0.2.0-dev.42", prerelease: true, draft: false },
    ]);
    expect(tag).toBe("v0.2.0-dev.42");
  });

  it("recognizes the mirrored windows asset", () => {
    expect(isSupportedCliAsset("gsv-windows-x64.exe")).toBe(true);
  });

  it("builds a windows installer script for the mirrored x64 asset", () => {
    const script = buildCliInstallPowerShell("https://example.test");
    expect(script).toContain("$BinaryName = 'gsv-windows-x64.exe'");
    expect(script).toContain("Using the Windows x64 CLI build on ARM64.");
  });
});
