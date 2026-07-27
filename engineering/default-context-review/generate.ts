import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BOOT_CONTEXT_TEMPLATE,
  DEFAULT_MEMORY_CONTEXT_TEMPLATE,
  DEFAULT_OPEN_LOOPS_CONTEXT,
  DEFAULT_STYLE_CONTEXT,
} from "../../gateway/src/prompts/agent-home.ts";
import {
  GSV_CONTEXT_DISCOVERY,
  GSV_PROCESS_ORCHESTRATION,
  GSV_RUNTIME_CONTEXT,
  GSV_RUNTIME_FACTS,
  GSV_TARGET_CONTEXT,
} from "../../gateway/src/prompts/system.ts";

const REVIEW_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(REVIEW_DIR, "../..");
const OUTPUT_PATH = resolve(REVIEW_DIR, "snapshot.js");
const MAX_DESCRIPTION_LENGTH = 220;

type SourceRef = {
  path: string;
  line: number;
  label: string;
};

type ReviewBlock = {
  id: string;
  group: "system" | "program" | "skills";
  filename?: string;
  tagName?: string;
  runtimePath: string;
  template: string;
  defaultIncluded: boolean;
  kind: "live-config" | "seeded-home" | "derived-index";
  note: string;
  sourceRefs: SourceRef[];
};

async function sourceRef(
  path: string,
  needle: string,
  label: string,
): Promise<SourceRef> {
  const absolutePath = resolve(REPO_ROOT, path);
  const source = await readFile(absolutePath, "utf8");
  const index = source.indexOf(needle);
  if (index < 0) {
    throw new Error(`Could not find ${JSON.stringify(needle)} in ${path}`);
  }
  return {
    path,
    line: source.slice(0, index).split("\n").length,
    label,
  };
}

async function refs(
  values: Array<[path: string, needle: string, label: string]>,
): Promise<SourceRef[]> {
  return Promise.all(values.map(([path, needle, label]) => sourceRef(path, needle, label)));
}

function parseFrontmatter(content: string): { frontmatter: Map<string, string>; body: string } {
  const frontmatter = new Map<string, string>();
  if (!content.startsWith("---")) {
    return { frontmatter, body: content };
  }

  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter, body: content };
  }

  const raw = content.slice(3, end);
  const body = content.slice(end + 4).replace(/^\r?\n/, "");
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim();
    if (value === ">" || value === "|") {
      const block: string[] = [];
      while (index + 1 < lines.length && /^(?:\s+|$)/.test(lines[index + 1])) {
        index += 1;
        block.push(lines[index].trim());
      }
      frontmatter.set(key, value === ">" ? block.join(" ") : block.join("\n"));
      continue;
    }
    frontmatter.set(key, unquoteYamlScalar(value));
  }
  return { frontmatter, body };
}

function unquoteYamlScalar(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function firstBodyDescription(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("---")) continue;
    return trimmed;
  }
  return "";
}

function truncateDescription(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= MAX_DESCRIPTION_LENGTH) return oneLine;
  return `${oneLine.slice(0, MAX_DESCRIPTION_LENGTH - 3).trimEnd()}...`;
}

function escapePromptText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function readSeededSkills(): Promise<{
  entries: Array<{ id: string; name: string; description: string }>;
  refs: SourceRef[];
}> {
  const skillsRoot = resolve(REPO_ROOT, "skills");
  const names = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const entries: Array<{ id: string; name: string; description: string }> = [];
  const skillRefs: SourceRef[] = [];

  for (const directoryName of names) {
    const path = `skills/${directoryName}/SKILL.md`;
    const content = await readFile(resolve(REPO_ROOT, path), "utf8");
    const { frontmatter, body } = parseFrontmatter(content);
    const name = (frontmatter.get("name") ?? directoryName)
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase();
    const description = truncateDescription(
      frontmatter.get("description") ?? firstBodyDescription(body),
    );
    entries.push({ id: name, name, description });
    skillRefs.push(await sourceRef(path, "description:", `${name} description`));
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));
  return { entries, refs: skillRefs };
}

function renderSkillIndex(
  entries: Array<{ id: string; description: string }>,
): string {
  const lines = [
    "Available skills are top-level only. Use `skills list <skill>` or `skills tree <skill>` to inspect nested skills.",
    "Use `skills show <skill>` before relying on a reusable workflow.",
  ];
  if (entries.length === 0) return lines.join("\n");
  lines.push("");
  for (const entry of entries) {
    lines.push([
      "<skill>",
      `<name>${escapePromptText(entry.id)}</name>`,
      `<description>${escapePromptText(entry.description || "No description.")}</description>`,
      "</skill>",
    ].join("\n"));
  }
  return lines.join("\n");
}

async function buildSnapshot(): Promise<Record<string, unknown>> {
  const systemBlocks: ReviewBlock[] = [
    {
      id: "system:00-runtime.md",
      group: "system",
      filename: "00-runtime.md",
      runtimePath: "/sys/config/ai/context.d/00-runtime.md",
      template: GSV_RUNTIME_FACTS,
      defaultIncluded: true,
      kind: "live-config",
      note: "Rendered at run start with owner, agent, date, timezone, targets, and ready MCP servers.",
      sourceRefs: await refs([
        ["gateway/src/prompts/system.ts", "export const GSV_RUNTIME_FACTS", "prompt template"],
        ["gateway/src/process/context/providers/system.ts", "function renderContextTemplate", "runtime rendering"],
      ]),
    },
    {
      id: "system:01-gsv.md",
      group: "system",
      filename: "01-gsv.md",
      runtimePath: "/sys/config/ai/context.d/01-gsv.md",
      template: GSV_RUNTIME_CONTEXT,
      defaultIncluded: true,
      kind: "live-config",
      note: "A ConfigStore default read on every new run; an explicit system config value can override it.",
      sourceRefs: await refs([
        ["gateway/src/prompts/system.ts", "export const GSV_RUNTIME_CONTEXT", "prompt text"],
        ["gateway/src/kernel/config.ts", "\"config/ai/context.d/01-gsv.md\"", "default config mapping"],
      ]),
    },
    {
      id: "system:05-targets.md",
      group: "system",
      filename: "05-targets.md",
      runtimePath: "/sys/config/ai/context.d/05-targets.md",
      template: GSV_TARGET_CONTEXT,
      defaultIncluded: true,
      kind: "live-config",
      note: "Shared target and delivery guidance from the operator-managed system context.",
      sourceRefs: await refs([
        ["gateway/src/prompts/system.ts", "export const GSV_TARGET_CONTEXT", "prompt text"],
        ["gateway/src/kernel/config.ts", "\"config/ai/context.d/05-targets.md\"", "default config mapping"],
      ]),
    },
    {
      id: "system:20-discovery.md",
      group: "system",
      filename: "20-discovery.md",
      runtimePath: "/sys/config/ai/context.d/20-discovery.md",
      template: GSV_CONTEXT_DISCOVERY,
      defaultIncluded: true,
      kind: "live-config",
      note: "Shared GSV command, MCP, and skill discovery guidance.",
      sourceRefs: await refs([
        ["gateway/src/prompts/system.ts", "export const GSV_CONTEXT_DISCOVERY", "prompt text"],
        ["gateway/src/kernel/config.ts", "\"config/ai/context.d/20-discovery.md\"", "default config mapping"],
      ]),
    },
    {
      id: "system:30-process-orchestration.md",
      group: "system",
      filename: "30-process-orchestration.md",
      runtimePath: "/sys/config/ai/context.d/30-process-orchestration.md",
      template: GSV_PROCESS_ORCHESTRATION,
      defaultIncluded: true,
      kind: "live-config",
      note: "A compact pointer to the process-orchestration skill for delegation and scheduling.",
      sourceRefs: await refs([
        ["gateway/src/prompts/system.ts", "export const GSV_PROCESS_ORCHESTRATION", "prompt text"],
        ["gateway/src/kernel/config.ts", "\"config/ai/context.d/30-process-orchestration.md\"", "default config mapping"],
      ]),
    },
  ];

  const programBlocks: ReviewBlock[] = [
    {
      id: "program:00-boot.md",
      group: "program",
      filename: "00-boot.md",
      runtimePath: "{{program.home}}/context.d/00-boot.md",
      template: DEFAULT_BOOT_CONTEXT_TEMPLATE,
      defaultIncluded: true,
      kind: "seeded-home",
      note: "Still present on the first Chat turn. sys.setup seeds it for a personal agent and does not remove it when the web wizard finishes.",
      sourceRefs: await refs([
        ["gateway/src/prompts/agent-home.ts", "export const DEFAULT_BOOT_CONTEXT_TEMPLATE", "seed template"],
        ["gateway/src/kernel/accounts.ts", "seedBootContext: input.personalAgentOf != null", "personal-agent seed decision"],
      ]),
    },
    {
      id: "program:00-style.md",
      group: "program",
      filename: "00-style.md",
      runtimePath: "{{program.home}}/context.d/00-style.md",
      template: DEFAULT_STYLE_CONTEXT,
      defaultIncluded: true,
      kind: "seeded-home",
      note: "Copied once into the agent home. Later source changes do not replace a user-edited copy.",
      sourceRefs: await refs([
        ["gateway/src/prompts/agent-home.ts", "export const DEFAULT_STYLE_CONTEXT", "seed text"],
        ["gateway/src/kernel/account-home.ts", "\"context.d/00-style.md\"", "home seeding"],
      ]),
    },
    {
      id: "program:15-memory.md",
      group: "program",
      filename: "15-memory.md",
      runtimePath: "{{program.home}}/context.d/15-memory.md",
      template: DEFAULT_MEMORY_CONTEXT_TEMPLATE,
      defaultIncluded: true,
      kind: "seeded-home",
      note: "Standing instructions for the agent's repo-backed memory wiki.",
      sourceRefs: await refs([
        ["gateway/src/prompts/agent-home.ts", "export const DEFAULT_MEMORY_CONTEXT_TEMPLATE", "seed template"],
        ["gateway/src/kernel/account-home.ts", "\"context.d/15-memory.md\"", "home seeding"],
      ]),
    },
    {
      id: "program:20-open-loops.md",
      group: "program",
      filename: "20-open-loops.md",
      runtimePath: "{{program.home}}/context.d/20-open-loops.md",
      template: DEFAULT_OPEN_LOOPS_CONTEXT,
      defaultIncluded: true,
      kind: "seeded-home",
      note: "An initially empty standing list that is nevertheless included verbatim.",
      sourceRefs: await refs([
        ["gateway/src/prompts/agent-home.ts", "export const DEFAULT_OPEN_LOOPS_CONTEXT", "seed text"],
        ["gateway/src/kernel/account-home.ts", "\"context.d/20-open-loops.md\"", "home seeding"],
      ]),
    },
  ];

  const skills = await readSeededSkills();
  const skillsBlock: ReviewBlock = {
    id: "skills:available-skills",
    group: "skills",
    tagName: "available_skills",
    runtimePath: "owner ~/skills.d index",
    template: renderSkillIndex(skills.entries),
    defaultIncluded: true,
    kind: "derived-index",
    note: "Not context.d: rendered from the top-level skills seeded into the human owner's home during bootstrap.",
    sourceRefs: [
      ...(await refs([
        ["gateway/src/kernel/skills.ts", "export function renderSkillIndex", "index renderer"],
        ["gateway/src/kernel/sys/skills-seed.ts", "export async function seedRepoSkillsToHome", "bootstrap seeding"],
      ])),
      ...skills.refs,
    ],
  };

  const blocks = [...systemBlocks, ...programBlocks, skillsBlock];
  const sourceFingerprint = createHash("sha256")
    .update(JSON.stringify(blocks.map(({ id, template }) => ({ id, template }))))
    .digest("hex")
    .slice(0, 12);

  return {
    schemaVersion: 1,
    sourceFingerprint,
    title: "Default personal-agent context",
    scope: "First Chat message after the web setup wizard completes",
    defaultScenario: {
      userUsername: "alex",
      agentUsername: "friday",
      currentDate: "",
      timezone: "Europe/Amsterdam",
      targets: "- gsv",
      mcpServers: "- (none)",
      firstMessage: "Hello",
    },
    groups: [
      {
        id: "system",
        label: "System config",
        shortLabel: "System",
        rootTag: "system",
        pathTemplate: "/sys/config/ai/context.d",
        access: "root-managed config",
        color: "blue",
      },
      {
        id: "program",
        label: "Personal-agent home",
        shortLabel: "Agent home",
        rootTag: "program",
        pathTemplate: "{{program.home}}/context.d",
        access: "user-editable home files",
        color: "amber",
      },
      {
        id: "skills",
        label: "Available skills",
        shortLabel: "Skills",
        rootTag: null,
        pathTemplate: "{{user.home}}/skills.d",
        access: "derived index",
        color: "violet",
      },
    ],
    blocks,
    skillEntries: skills.entries,
    notIncluded: [
      {
        id: "owner-context",
        title: "Owner home context",
        pathTemplate: "{{user.home}}/context.d/*.md",
        status: "empty on a fresh setup",
        explanation: "The human home is created with directory markers and seeded skills, but no default Markdown context files. The owner provider therefore emits no <user> root on the first turn.",
        sourceRefs: await refs([
          ["gateway/src/process/context/providers/owner.ts", "export function createOwnerContextProvider", "owner provider"],
          ["gateway/src/kernel/sys/setup.ts", "cleanupGeneratedPromptContext: true", "fresh human cleanup"],
        ]),
      },
    ],
    trace: [
      {
        label: "Run input",
        detail: "The Process DO resolves ai.config and ai.tools once, then asks the context assembler for systemPrompt.",
        sourceRef: await sourceRef(
          "gateway/src/process/do.ts",
          "run.systemPrompt = await assembleSystemPrompt",
          "first-tick assembly",
        ),
      },
      {
        label: "Provider order",
        detail: "system → personal-agent home → human owner home → skills",
        sourceRef: await sourceRef(
          "gateway/src/process/context/selection.ts",
          "export function resolvePromptProviders",
          "provider selection",
        ),
      },
      {
        label: "Final serialization",
        detail: "Context roots are grouped first; regular sections such as available_skills follow. Empty files and roots disappear.",
        sourceRef: await sourceRef(
          "gateway/src/process/context/assembly.ts",
          "export async function assembleSystemPrompt",
          "prompt serializer",
        ),
      },
      {
        label: "Adjacent model input",
        detail: "The first user message is separately annotated with its source and reply destination; seven syscall tool schemas are another field, not part of systemPrompt.",
        sourceRef: await sourceRef(
          "gateway/src/process/do.ts",
          "private async buildContextMessages",
          "message annotation",
        ),
      },
    ],
  };
}

async function main(): Promise<void> {
  const snapshot = await buildSnapshot();
  const output = [
    "// Generated by generate.ts from the current prompt and skill sources.",
    "// Run generate.ts --check to detect a stale review snapshot.",
    `window.GSV_CONTEXT_REVIEW_SNAPSHOT = ${JSON.stringify(snapshot, null, 2)};`,
    "",
  ].join("\n");

  if (process.argv.includes("--check")) {
    const current = await readFile(OUTPUT_PATH, "utf8").catch(() => "");
    if (current !== output) {
      throw new Error(
        `${relative(REPO_ROOT, OUTPUT_PATH)} is stale; run ` +
        "gateway/node_modules/.bin/tsx engineering/default-context-review/generate.ts",
      );
    }
    console.log(`Context review snapshot is current (${snapshot.sourceFingerprint}).`);
    return;
  }

  await writeFile(OUTPUT_PATH, output, "utf8");
  console.log(`Wrote ${relative(REPO_ROOT, OUTPUT_PATH)} (${snapshot.sourceFingerprint}).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
