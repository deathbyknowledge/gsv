import { assembleSystemPromptSnapshot } from "../../workers/gateway/src/process/context/assembly";
import { resolvePromptProviders } from "../../workers/gateway/src/process/context/selection";
import type { PromptAssemblyInput, PromptAssemblySnapshot, PromptSection } from "../../workers/gateway/src/process/context/types";
import { SYSTEM_CONFIG_DEFAULTS } from "../../workers/gateway/src/kernel/config";
import { parseSkillMarkdown } from "../../workers/gateway/src/kernel/skills";
import { BUILTIN_SKILL_FILES } from "../../workers/gateway/src/kernel/sys/builtin-skills";
import {
  DEFAULT_STYLE_CONTEXT, DEFAULT_MEMORY_CONTEXT_TEMPLATE, PERSONAL_STANDING_CONTEXT,
} from "../../workers/gateway/src/prompts/agent-home";
import {
  PERSONAL_INTELLIGENCE_CONTEXT, PERSONAL_INTELLIGENCE_VOICE_CONTEXT,
  CREW_CONTEXT, crewDelegationContext,
} from "../../workers/gateway/src/prompts/personal-intelligence";
import { GSV_DELEGATED_TASK_CONTEXT } from "../../workers/gateway/src/prompts/system";
import { COMPACTION_SUMMARY_SYSTEM_PROMPT } from "../../workers/gateway/src/prompts/compaction";
import { SETUP_ASSIST_SYSTEM_PROMPT } from "../../workers/gateway/src/prompts/setup-assist";
import { YIELD_CORRECTION_MESSAGE } from "../../workers/gateway/src/prompts/correction-events";

export type PreviewAccount = "ship" | "crew";
type PreviewSection = PromptSection & { path?: string; provider: string };
type PromptPreview = PromptAssemblySnapshot & {
  sections: PreviewSection[];
  catalog: Array<{ path: string; text: string }>;
};

// This fixture uses the production defaults and providers, with local sample identities.
// It never contacts a space or reads customer context.
export async function createPromptPreview(account: PreviewAccount): Promise<PromptPreview> {
  const systemContextFiles = Object.entries(SYSTEM_CONFIG_DEFAULTS)
    .filter(([key]) => key.startsWith("config/ai/context.d/"))
    .map(([key, text]) => ({ name: key.slice("config/ai/context.d/".length), text }));
  const catalog = [
    ...systemContextFiles.map(({ name, text }) => ({ path: `system/${name}`, text })),
    { path: "ship/00-role.md", text: PERSONAL_INTELLIGENCE_CONTEXT },
    { path: "ship/05-voice.md", text: PERSONAL_INTELLIGENCE_VOICE_CONTEXT },
    { path: "ship/10-delegation.md", text: crewDelegationContext("crew") },
    { path: "crew/00-role.md", text: CREW_CONTEXT },
    { path: "agent/00-style.md", text: DEFAULT_STYLE_CONTEXT },
    { path: "agent/15-memory.md", text: DEFAULT_MEMORY_CONTEXT_TEMPLATE },
    { path: "user/10-personal.md", text: PERSONAL_STANDING_CONTEXT },
    { path: "tasks/delegated.md", text: GSV_DELEGATED_TASK_CONTEXT },
    { path: "tasks/compaction.md", text: COMPACTION_SUMMARY_SYSTEM_PROMPT },
    { path: "tasks/setup-assist.md", text: SETUP_ASSIST_SYSTEM_PROMPT },
    { path: "tasks/yield-correction.md", text: YIELD_CORRECTION_MESSAGE },
  ];
  const program = catalog.filter(({ path }) => path.startsWith(`${account}/`)
    || (account === "crew" && path.startsWith("agent/")));
  const owner = catalog.filter(({ path }) => path.startsWith("user/"));
  const files = new Map([...program, ...owner].map(({ path, text }) => [
    `home/${path.startsWith("user/") ? "alex" : account}/context.d/${path.split("/")[1]}`,
    text,
  ]));
  const identity = (username: string, uid: number) => ({
    username, uid, gid: uid, gids: [uid, 100], home: `/home/${username}`, cwd: `/home/${username}`,
  });
  const input: PromptAssemblyInput = {
    identity: identity(account, account === "ship" ? 1001 : 1002),
    ownerIdentity: identity("alex", 1000),
    config: {
      executor: { kind: "process", pid: "proc:preview" },
      provider: "gsv", model: "default", reasoning: "off", maxTokens: 4096,
      apiKey: "", capabilities: [], generationTimeoutMs: 180000,
      contextWindowTokens: 128000, contextWindowSource: "model",
      maxContextBytes: Number(SYSTEM_CONFIG_DEFAULTS["config/ai/max_context_bytes"]),
      systemContextFiles,
      skillIndex: BUILTIN_SKILL_FILES.map(({ path, content }) => {
        const id = path.split("/")[0];
        const metadata = parseSkillMarkdown(content, id);
        return { id, name: metadata.name, description: metadata.description,
          source: { kind: "home", label: `home:${id}`, writable: true } };
      }),
    },
    runtime: { date: "2026-01-01", timezone: "UTC" },
    targets: [{ id: "laptop", label: "Laptop", implements: ["shell.exec", "fs.read"] }],
    mcpServers: [],
    r12y: "No unresolved responsibilities.",
    ripgit: {
      async readPath(repo, path) {
        const prefix = `home/${repo.owner}/${path}`;
        if (path === "context.d") {
          return { kind: "tree", entries: [...files.keys()]
            .filter((key) => key.startsWith(`${prefix}/`))
            .map((key) => ({ name: key.slice(prefix.length + 1), type: "blob", mode: "100644", hash: "preview" })) };
        }
        const text = files.get(prefix);
        return text === undefined ? { kind: "missing" }
          : { kind: "file", bytes: new TextEncoder().encode(text), size: new TextEncoder().encode(text).length };
      },
    },
    storage: {
      async get() { throw new Error("Preview context must come from its local fixture"); },
      async list() { throw new Error("Preview context must come from its local fixture"); },
    },
  };
  const sections: PreviewSection[] = [];
  const providers = resolvePromptProviders().map((provider) => ({
    name: provider.name,
    async collect(assemblyInput: PromptAssemblyInput) {
      const collected = await provider.collect(assemblyInput);
      for (const section of collected) {
        const root = section.contextRoot?.key;
        const source = root === "program" ? program.find(({ path }) => path.endsWith(`/${section.name}`))
          : root === "user" ? owner.find(({ path }) => path.endsWith(`/${section.name}`))
          : catalog.find(({ path }) => path === `system/${section.name}`);
        sections.push({ ...section, path: source?.path, provider: provider.name });
      }
      return collected;
    },
  }));
  const snapshot = await assembleSystemPromptSnapshot(input, providers);
  return { ...snapshot, sections, catalog };
}
