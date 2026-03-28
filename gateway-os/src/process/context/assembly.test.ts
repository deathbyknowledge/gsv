import { describe, expect, it } from "vitest";
import { assembleSystemPrompt } from "./assembly";
import { createHomeKnowledgeProvider } from "./providers/home";
import { createProfileInstructionsProvider } from "./providers/profile";
import { createWorkspaceSummaryProvider } from "./providers/workspace";
import { resolvePromptProviders } from "./selection";
import type { PromptAssemblyInput, PromptContextProvider } from "./types";
import type { AiConfigResult } from "../../syscalls/ai";
import type { ProcessIdentity } from "../../syscalls/system";

const CONFIG: AiConfigResult = {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  apiKey: "test-key",
  reasoning: "off",
  maxTokens: 4096,
  systemPrompt: "base prompt",
  profileSystemPrompt: "task prompt",
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
  it("renders profile-scoped instructions from config", async () => {
    const provider = createProfileInstructionsProvider();
    const sections = await provider.collect(makeInput());
    expect(sections).toEqual([
      {
        name: "profile.instructions:task",
        text: "task prompt",
      },
    ]);
  });
});

describe("selection", () => {
  it("includes profile instructions in the default task plan", () => {
    const providers = resolvePromptProviders("task", "chat.reply");
    expect(providers.map((provider) => provider.name)).toEqual([
      "base.system_prompt",
      "profile.instructions",
      "home.knowledge",
      "workspace.summary",
    ]);
  });
});

describe("createHomeKnowledgeProvider", () => {
  it("loads constitution and sorted context files within budget", async () => {
    const provider = createHomeKnowledgeProvider();
    const sections = await provider.collect(
      makeInput({
        config: { ...CONFIG, maxContextBytes: 20 },
        knowledge: {
          async read(path: string) {
            if (path === "CONSTITUTION.md") {
              return fileObject("constitution");
            }
            if (path === "context.d/a.md") {
              return fileObject("alpha");
            }
            if (path === "context.d/b.md") {
              return fileObject("beta beta beta beta");
            }
            return { kind: "missing" } as const;
          },
          async list() {
            return [
              { path: "context.d/b.md", name: "b.md", kind: "file" as const },
              { path: "context.d/a.md", name: "a.md", kind: "file" as const },
            ];
          },
        } as PromptAssemblyInput["knowledge"],
      }),
    );

    expect(sections.map((section) => section.name)).toEqual([
      "home.constitution",
      "home.context:a.md",
    ]);
    expect(sections.map((section) => section.text)).toEqual([
      "constitution",
      "alpha",
    ]);
  });
});

describe("createWorkspaceSummaryProvider", () => {
  it("loads workspace summary from ripgit when available", async () => {
    const provider = createWorkspaceSummaryProvider();
    const sections = await provider.collect(
      makeInput({
        ripgit: {
          async readPath() {
            return {
              kind: "file",
              bytes: new TextEncoder().encode("Summary text"),
              size: 12,
            };
          },
        },
      }),
    );

    expect(sections).toEqual([
      {
        name: "workspace.summary",
        text: "Current workspace summary:\n\nSummary text",
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
    knowledge: null,
    ripgit: null,
    ...overrides,
  };
}

function fileObject(text: string) {
  return {
    kind: "file" as const,
    bytes: new TextEncoder().encode(text),
    size: text.length,
  };
}
