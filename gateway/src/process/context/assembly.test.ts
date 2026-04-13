import { describe, expect, it } from "vitest";
import { assembleSystemPrompt } from "./assembly";
import { createHomeContextProvider } from "./providers/home";
import { createProfileInstructionsProvider } from "./providers/profile";
import { createWorkspaceContextProvider } from "./providers/workspace";
import { resolvePromptProviders } from "./selection";
import type { PromptAssemblyInput, PromptContextProvider } from "./types";
import type { AiConfigResult } from "../../syscalls/ai";
import type { ProcessIdentity } from "../../syscalls/system";
import { homeKnowledgeRepoRef, workspaceRepoRef } from "../../fs";

const CONFIG: AiConfigResult = {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  apiKey: "test-key",
  reasoning: "off",
  maxTokens: 4096,
  profileContextFiles: [
    {
      name: "00-role.md",
      text: "Task for {{identity.username}} in {{identity.cwd}}\n\nTargets:\n{{devices}}\n\nPaths:\n{{known_paths}}",
    },
  ],
  maxContextBytes: 64,
};

const IDENTITY: ProcessIdentity = {
  uid: 0,
  gid: 0,
  gids: [0],
  username: "root",
  home: "/root",
  cwd: "/workspaces/ws_test",
  workspaceId: "ws_test",
};

describe("assembleSystemPrompt", () => {
  it("preserves provider order and skips empty sections", async () => {
    const providers: PromptContextProvider[] = [
      {
        name: "one",
        async collect() {
          return [{ name: "one", text: "first" }];
        },
      },
      {
        name: "two",
        async collect() {
          return [{ name: "two", text: "   " }];
        },
      },
      {
        name: "three",
        async collect() {
          return [{ name: "three", text: "third" }];
        },
      },
    ];

    const prompt = await assembleSystemPrompt(makeInput(), providers);
    expect(prompt).toBe("[one]\nfirst\n\n---\n\n[three]\nthird");
  });
});

describe("createProfileInstructionsProvider", () => {
  it("renders profile context files from config and runtime placeholders", async () => {
    const provider = createProfileInstructionsProvider();
    const sections = await provider.collect(
      makeInput({
        devices: [
          {
            id: "macbook",
            platform: "darwin",
            implements: ["shell.exec", "fs.read"],
          },
        ],
      }),
    );
    expect(sections).toEqual([
      expect.objectContaining({
        name: "profile.context:00-role.md",
      }),
    ]);
    expect(sections[0]?.text).toContain("Task for root in /workspaces/ws_test");
    expect(sections[0]?.text).toContain("- gsv: control plane and local execution target");
    expect(sections[0]?.text).toContain("- macbook — darwin");
    expect(sections[0]?.text).toContain("- /sys: live kernel configuration and runtime control surfaces");
  });
});

describe("selection", () => {
  it("includes profile instructions in the default task plan", () => {
    const providers = resolvePromptProviders("task", "chat.reply");
    expect(providers.map((provider) => provider.name)).toEqual([
      "profile.context",
      "home.context",
      "workspace.context",
    ]);
  });
});

describe("createHomeContextProvider", () => {
  it("loads sorted context files within budget", async () => {
    const provider = createHomeContextProvider();
    const homeRepo = homeKnowledgeRepoRef(IDENTITY.uid);
    const sections = await provider.collect(
      makeInput({
        config: { ...CONFIG, maxContextBytes: 20 },
        ripgit: {
          async readPath(repo, path) {
            if (repo.owner !== homeRepo.owner || repo.repo !== homeRepo.repo) {
              return { kind: "missing" };
            }
            if (path === "context.d") {
              return {
                kind: "tree",
                entries: [
                  { name: "b.md", mode: "100644", hash: "b", type: "blob" },
                  { name: "a.md", mode: "100644", hash: "a", type: "blob" },
                ],
              };
            }
            if (path === "context.d/a.md") {
              return {
                kind: "file",
                bytes: new TextEncoder().encode("alpha"),
                size: 5,
              };
            }
            if (path === "context.d/b.md") {
              return {
                kind: "file",
                bytes: new TextEncoder().encode("beta beta beta beta"),
                size: 19,
              };
            }
            return { kind: "missing" };
          },
        },
      }),
    );

    expect(sections.map((section) => section.name)).toEqual([
      "home.context:a.md",
    ]);
    expect(sections.map((section) => section.text)).toEqual([
      "alpha",
    ]);
  });
});

describe("createWorkspaceContextProvider", () => {
  it("loads workspace context from ripgit when available", async () => {
    const provider = createWorkspaceContextProvider();
    const workspaceRepo = workspaceRepoRef("ws_test", IDENTITY.uid);
    const sections = await provider.collect(
      makeInput({
        ripgit: {
          async readPath(repo, path) {
            if (repo.owner !== workspaceRepo.owner || repo.repo !== workspaceRepo.repo) {
              return { kind: "missing" };
            }
            if (path === ".gsv/context.d") {
              return {
                kind: "tree",
                entries: [
                  { name: "10-summary.md", mode: "100644", hash: "a", type: "blob" },
                ],
              };
            }
            if (path === ".gsv/context.d/10-summary.md") {
              return {
                kind: "file",
                bytes: new TextEncoder().encode("Summary text"),
                size: 12,
              };
            }
            return { kind: "missing" };
          },
        },
      }),
    );

    expect(sections).toEqual([
      {
        name: "workspace.context:10-summary.md",
        text: "Summary text",
      },
    ]);
  });
});

function makeInput(overrides: Partial<PromptAssemblyInput> = {}): PromptAssemblyInput {
  return {
    config: CONFIG,
    profile: "task",
    purpose: "chat.reply",
    identity: IDENTITY,
    devices: [],
    storage: {
      async get() {
        return null;
      },
      async list() {
        return { objects: [] };
      },
    },
    ripgit: null,
    ...overrides,
  };
}
