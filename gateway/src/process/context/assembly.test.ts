import { describe, expect, it } from "vitest";
import { assembleSystemPrompt } from "./assembly";
import { createHomeContextProvider } from "./providers/home";
import { createSystemContextProvider } from "./providers/system";
import { resolvePromptProviders } from "./selection";
import type { PromptAssemblyInput, PromptContextProvider } from "./types";
import type { AiConfigResult } from "../../syscalls/ai";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { accountHomeRepoRef } from "../../fs";

const CONFIG: AiConfigResult = {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  apiKey: "test-key",
  reasoning: "off",
  maxTokens: 4096,
  contextWindowTokens: 200000,
  contextWindowSource: "model",
  system: {
    timezone: "Europe/Amsterdam",
  },
  systemContextFiles: [
    {
      name: "00-gsv.md",
      text: "Running in GSV for {{identity.username}} at {{identity.cwd}}",
    },
    {
      name: "10-runtime.md",
      text: "Task for {{identity.username}} in {{identity.cwd}}\nToday is {{current.date}} in {{current.timezone}}\nUser {{user.username}} at {{user.home}}\nProgram {{program.username}} at {{program.home}} cwd {{program.cwd}}\nOwner {{owner.username}} at {{owner.home}}\n\nTargets:\n{{devices}}\n\nMCP:\n{{mcpServers}}",
    },
  ],
  skillIndex: [
    {
      id: "package-development",
      name: "package-development",
      description: "Build and update packages.",
      source: {
        kind: "home",
        label: "home:package-development",
        writable: false,
      },
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
  cwd: "/root/projects/demo",
};

const OWNER_IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000, 100],
  username: "hank",
  home: "/home/hank",
  cwd: "/home/hank",
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
    expect(prompt).toBe("<one>\nfirst\n</one>\n\n<three>\nthird\n</three>");
  });

  it("groups context files by root and omits empty roots", async () => {
    const providers: PromptContextProvider[] = [
      {
        name: "system.context",
        async collect() {
          return [
            {
              name: "00-gsv.md",
              text: "system context",
              contextRoot: {
                key: "system",
                label: "SYSTEM",
                access: "read-only",
                location: "/sys/config/ai/context.d",
              },
            },
          ];
        },
      },
      {
        name: "program.context",
        async collect() {
          return [
            {
              name: "00-style.md",
              text: "program context",
              contextRoot: {
                key: "program",
                label: "PROGRAM",
                access: "editable",
                location: "/home/friday/context.d",
              },
            },
          ];
        },
      },
      {
        name: "process.context",
        async collect() {
          return [
            {
              name: "20-empty.md",
              text: "   ",
              contextRoot: {
                key: "process",
                label: "PROCESS",
                access: "read-only",
                location: "current process assignment",
              },
            },
          ];
        },
      },
      {
        name: "available.skills",
        async collect() {
          return [{ name: "available.skills", text: "skill index" }];
        },
      },
    ];

    const prompt = await assembleSystemPrompt(makeInput(), providers);
    expect(prompt).toBe([
      "<system path=\"/sys/config/ai/context.d/\">",
      "<00-gsv.md>",
      "system context",
      "</00-gsv.md>",
      "</system>",
      "",
      "<program path=\"/home/friday/context.d/\">",
      "<00-style.md>",
      "program context",
      "</00-style.md>",
      "</program>",
      "",
      "<available_skills>",
      "skill index",
      "</available_skills>",
    ].join("\n"));
    expect(prompt).not.toContain("<process");
    expect(prompt).not.toContain("20-empty.md");
  });
});

describe("createSystemContextProvider", () => {
  it("renders system context files from config and runtime placeholders", async () => {
    const provider = createSystemContextProvider();
    const sections = await provider.collect(
      makeInput({
        devices: [
          {
            id: "macbook",
            label: "Work MacBook",
            platform: "darwin",
            description: "Personal laptop",
            implements: ["shell.exec", "fs.read"],
          },
        ],
        mcpServers: ["Linear", "Cloudflare"],
        ownerIdentity: OWNER_IDENTITY,
      }),
    );
    expect(sections).toEqual([
      expect.objectContaining({
        name: "00-gsv.md",
        contextRoot: expect.objectContaining({
          key: "system",
          label: "SYSTEM",
          location: "/sys/config/ai/context.d",
        }),
      }),
      expect.objectContaining({
        name: "10-runtime.md",
        contextRoot: expect.objectContaining({
          key: "system",
          label: "SYSTEM",
          location: "/sys/config/ai/context.d",
        }),
      }),
    ]);
    const text = sections.map((section) => section.text).join("\n");
    const expectedDate = currentDateInTimezone("Europe/Amsterdam");
    expect(text).toContain("Running in GSV for root at /root/projects/demo");
    expect(text).toContain("Task for root in /root/projects/demo");
    expect(text).toContain(`Today is ${expectedDate} in Europe/Amsterdam`);
    expect(text).toContain("User hank at /home/hank");
    expect(text).toContain("Program root at /root cwd /root/projects/demo");
    expect(text).toContain("Owner hank at /home/hank");
    expect(text).toContain("- gsv");
    expect(text).toContain("- macbook: Work MacBook - Personal laptop (darwin)");
    expect(text).toContain("- Cloudflare");
    expect(text).toContain("- Linear");
  });

  it("bounds rendered target context and points to target discovery", async () => {
    const provider = createSystemContextProvider();
    const sections = await provider.collect(
      makeInput({
        devices: Array.from({ length: 7 }, (_value, index) => ({
          id: `node-${index + 1}`,
          label: `Node ${index + 1}`,
          platform: "linux",
          description: `Worker ${index + 1}`,
          implements: ["shell.exec"],
        })),
      }),
    );

    const text = sections.map((section) => section.text).join("\n");
    expect(text).toContain("- node-1: Node 1 - Worker 1 (linux)");
    expect(text).toContain("- node-5: Node 5 - Worker 5 (linux)");
    expect(text).not.toContain("node-6");
    expect(text).toContain("- ... 2 more targets. Run `targets list` in Shell to discover more.");
  });
});

describe("selection", () => {
  it("includes context providers in the default task plan", () => {
    const providers = resolvePromptProviders("task");
    expect(providers.map((provider) => provider.name)).toEqual([
      "system.context",
      "home.context",
      "owner.context",
      "available.skills",
      "process.context",
    ]);
  });
});

describe("createSkillIndexProvider", () => {
  it("renders command-oriented skill discovery without source paths", async () => {
    const providers = resolvePromptProviders("task");
    const prompt = await assembleSystemPrompt(makeInput(), providers);

    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<system path=\"/sys/config/ai/context.d/\">");
    expect(prompt).not.toContain("<process");
    expect(prompt).toContain("Use `skills list <skill>`");
    expect(prompt).toContain("<skill>");
    expect(prompt).toContain("<name>package-development</name>");
    expect(prompt).toContain("<description>Build and update packages.</description>");
    expect(prompt).not.toContain("/src/packages/");
    expect(prompt).not.toContain("system.context:");
  });
});

describe("createHomeContextProvider", () => {
  it("loads sorted context files within budget", async () => {
    const provider = createHomeContextProvider();
    const homeRepo = accountHomeRepoRef(IDENTITY.username);
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
      "a.md",
    ]);
    expect(sections[0].contextRoot).toEqual({
      key: "program",
      label: "PROGRAM",
      access: "editable",
      location: "/root/context.d",
    });
    expect(sections.map((section) => section.text)).toEqual([
      "alpha",
    ]);
  });
});

function makeInput(overrides: Partial<PromptAssemblyInput> = {}): PromptAssemblyInput {
  return {
    config: CONFIG,
    purpose: "chat.reply",
    identity: IDENTITY,
    devices: [],
    mcpServers: [],
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

function currentDateInTimezone(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}
