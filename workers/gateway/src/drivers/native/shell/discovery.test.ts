import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineCommand } from "just-bash";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { GsvFs } from "../../../fs/gsv-fs";
import type { KernelContext } from "../../../kernel/context";
import * as skills from "../../../kernel/skills";
import { testPeer } from "../../../test-support/peers";
import { ShellDiscoveryCatalog, formatShellDiscoveryResults } from "./discovery";

const identity: ProcessIdentity = { uid: 1000, gid: 1000, gids: [1000], username: "person", home: "/home/person", cwd: "/home/person" };

describe("native command availability", () => {
  beforeEach(() => {
    vi.spyOn(skills, "collectFilesystemSkillDocuments").mockResolvedValue([]);
    vi.spyOn(skills, "collectKernelSkillDocuments").mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { configured: false, allowed: true, missing: ["configured feedback inbox"] },
    { configured: true, allowed: false, missing: ["sys.feedback"] },
    { configured: false, allowed: false, missing: ["sys.feedback", "configured feedback inbox"] },
    { configured: true, allowed: true, missing: [] },
  ])("reports feedback availability for inbox=$configured and capability=$allowed", async ({ configured, allowed, missing }) => {
    const catalog = fixture(configured, allowed ? ["sys.feedback"] : []);
    const results = await catalog.search("feedback");
    const entry = results.find(entry => entry.name === "feedback");
    expect(entry?.available).toBe(missing.length === 0);
    expect(entry?.requirements).toEqual(missing.length ? missing : undefined);
    expect(formatShellDiscoveryResults("feedback", results)).toContain(`command\tfeedback\t${missing.length ? `no (${missing.join(", ")})` : "yes"}\t`);
    const manual = catalog.renderCommandManual("feedback");
    if (missing.length) expect(manual).toContain(`Missing requirements: ${missing.join(", ")}`);
    else expect(manual).not.toContain("CURRENT AVAILABILITY");
  });

  it("keeps targetable web search available without a native web search binding", async () => {
    const catalog = fixture(false, ["web.search"]);
    const results = await catalog.search("web search");
    expect(results.find(entry => entry.name === "web")).toMatchObject({ available: true });
  });
});

function fixture(configured: boolean, calls: string[]): ShellDiscoveryCatalog {
  // SAFETY: command discovery only reads this peer/environment; workflow discovery is stubbed above.
  const ctx = { peer: testPeer({ account: identity, calls }), env: configured
    ? { FEEDBACK: { submitFeedback: vi.fn() } } : {} } as KernelContext;
  // SAFETY: the stubbed workflow collectors never read the filesystem.
  const catalog = new ShellDiscoveryCatalog({} as GsvFs, identity, ctx);
  catalog.registerCommands(["feedback", "web"].map(name => defineCommand(name, async () => ({ stdout: "", stderr: "", exitCode: 0 }))));
  return catalog;
}
