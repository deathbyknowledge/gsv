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
import { CONTEXT_SOURCE_PATHS, PROMPT_SOURCES, type PromptSource } from "./prompt-sources";

export type PreviewAccount = "ship" | "crew";
type PreviewSection = PromptSection & { paths: string[]; provider: string };
type PromptPreview = PromptAssemblySnapshot & {
  sections: PreviewSection[];
  catalog: PromptSource[];
};

// This fixture uses the production defaults and providers, with local sample identities.
// It never contacts a space or reads customer context.
export async function createPromptPreview(account: PreviewAccount): Promise<PromptPreview> {
  const systemContextFiles = Object.entries(SYSTEM_CONFIG_DEFAULTS)
    .filter(([key]) => key.startsWith("config/ai/context.d/"))
    .map(([key, text]) => ({ name: key.slice("config/ai/context.d/".length), text }));
  const catalog = PROMPT_SOURCES;
  const program = account === "ship" ? [
    { name: "00-role.md", text: PERSONAL_INTELLIGENCE_CONTEXT },
    { name: "05-voice.md", text: PERSONAL_INTELLIGENCE_VOICE_CONTEXT },
    { name: "10-delegation.md", text: crewDelegationContext("crew") },
  ] : [
    { name: "00-role.md", text: CREW_CONTEXT },
    { name: "00-style.md", text: DEFAULT_STYLE_CONTEXT },
    { name: "15-memory.md", text: DEFAULT_MEMORY_CONTEXT_TEMPLATE },
  ];
  const files = new Map<string, string>([
    ...program.map(({ name, text }) => [`home/${account}/context.d/${name}`, text] as const),
    ["home/alex/context.d/10-personal.md", PERSONAL_STANDING_CONTEXT] as const,
  ]);
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
        const sourceScope = root === "program" ? account : root === "user" ? "user" : "system";
        const paths = CONTEXT_SOURCE_PATHS.get(`${sourceScope}/${section.name}`) ?? [];
        sections.push({ ...section, paths, provider: provider.name });
      }
      return collected;
    },
  }));
  const snapshot = await assembleSystemPromptSnapshot(input, providers);
  return { ...snapshot, sections, catalog };
}
