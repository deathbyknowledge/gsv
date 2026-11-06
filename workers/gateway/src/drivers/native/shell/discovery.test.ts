import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineCommand } from "just-bash";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { GsvFs } from "../../../fs/gsv-fs";
import type { KernelContext } from "../../../kernel/context";
import * as skills from "../../../kernel/skills";
import { testPeer } from "../../../test-support/peers";
import { ShellDiscoveryCatalog, formatShellDiscoveryResults, rankShellDiscoveryEntries, type ShellDiscoveryEntry } from "./discovery";

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

  it("discovers messenger setup and redemption without standing prompt instructions", async () => {
    const catalog = fixture(false, ["adapter.list", "adapter.pair.*"]);
    expect((await catalog.search("connect whatsapp")).find(entry => entry.name === "messenger")).toMatchObject({ available: true });
    expect(catalog.renderCommandManual("messenger")).toContain("messenger connect ADAPTER < code.txt");
  });
});

function fixture(configured: boolean, calls: string[]): ShellDiscoveryCatalog {
  // SAFETY: command discovery only reads this peer/environment; workflow discovery is stubbed above.
  const ctx = { peer: testPeer({ account: identity, calls }), env: configured
    ? { FEEDBACK: { submitFeedback: vi.fn() } } : {} } as KernelContext;
  // SAFETY: the stubbed workflow collectors never read the filesystem.
  const catalog = new ShellDiscoveryCatalog({} as GsvFs, identity, ctx);
  catalog.registerCommands(["feedback", "web", "messenger"].map(name => defineCommand(name, async () => ({ stdout: "", stderr: "", exitCode: 0 }))));
  return catalog;
}

describe("discovery ranking", () => {
  it("ranks a command that describes the task above a workflow that only mentions it in its body", () => {
    const entries: ShellDiscoveryEntry[] = [
      {
        kind: "workflow", name: "long-guide", summary: "A long guide.", useWhen: "Read the guide.", keywords: [],
        searchText: "Send this file to the chat when the person asks.", next: "skills show long-guide", available: true,
      },
      {
        kind: "command", name: "message", summary: "Send a message.", useWhen: "Send text to the chat.", keywords: [],
        next: "man message", available: true,
      },
    ];

    expect(rankShellDiscoveryEntries(entries, "send this file to the chat").map((entry) => entry.name))
      .toEqual(["message", "long-guide"]);
  });

  it.each([
    ["schedule a reminder", ["sched"]],
    ["store a secret", []],
    ["user's calendar", []],
  ])("does not match %s on the letters left over from possessives", (query, expected) => {
    const entries: ShellDiscoveryEntry[] = [
      {
        kind: "command", name: "sched", summary: "Schedule work for later.", useWhen: "Set a reminder.",
        keywords: ["reminder"], next: "man sched", available: true,
      },
      {
        kind: "command", name: "contact", summary: "Manage a person's contacts.", useWhen: "Read a contact's details.",
        keywords: [], next: "man contact", available: true,
      },
    ];

    expect(rankShellDiscoveryEntries(entries, query).map((entry) => entry.name)).toEqual(expected);
  });

  it.each([
    ["organize my notes", ["wiki"]],
    ["upload a photo", []],
  ])("does not prefix-match %s on two-letter words", (query, expected) => {
    const entries: ShellDiscoveryEntry[] = [
      {
        kind: "command", name: "chmod", summary: "Change who can read or write a file.", useWhen: "Set up sharing.",
        keywords: [], next: "man chmod", available: true,
      },
      {
        kind: "command", name: "wiki", summary: "Keep notes in a wiki.", useWhen: "Write down what to remember.",
        keywords: [], next: "man wiki", available: true,
      },
    ];

    expect(rankShellDiscoveryEntries(entries, query).map((entry) => entry.name)).toEqual(expected);
  });
});
