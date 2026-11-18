import { assembleSystemPromptSnapshot } from "../../workers/gateway/src/process/context/assembly";
import { resolvePromptProviders } from "../../workers/gateway/src/process/context/selection";
import type {
  PromptAssemblyInput, PromptAssemblySnapshot, PromptContextProvider, PromptSection, PromptSourceRecord,
} from "../../workers/gateway/src/process/context/types";
import { SYSTEM_CONFIG_DEFAULTS } from "../../workers/gateway/src/kernel/config";
import { parseSkillMarkdown } from "../../workers/gateway/src/kernel/skills";
import { BUILTIN_SKILL_NAMES, SYSTEM_SKILLS_ROOT, readSystemSkillPath } from "../../workers/gateway/src/kernel/sys/builtin-skills";
import { contextFiles } from "../../workers/gateway/src/prompts/context";
import { PROMPT_SOURCES, type PromptSource } from "./prompt-sources";

export type PreviewAccount = "ship" | "crew";
type PreviewSection = PromptSection & { paths: string[]; provider: string; contextRoot?: PromptSourceRecord["contextRoot"] };
type PromptPreview = PromptAssemblySnapshot & {
  sections: PreviewSection[];
  catalog: PromptSource[];
};

// This fixture uses the production defaults and providers, with local sample identities.
// It never contacts a space or reads customer context.
// homeFiles adds sample files to the account's own context.d, such as a voice.md, to show how layers combine.
export async function createPromptPreview(
  account: PreviewAccount,
  homeFiles: Record<string, string> = {},
): Promise<PromptPreview> {
  const systemContextFiles = Object.entries(SYSTEM_CONFIG_DEFAULTS)
    .filter(([key]) => key.startsWith("config/ai/context.d/"))
    .map(([key, text]) => ({ name: key.slice("config/ai/context.d/".length), text }));
  const catalog = PROMPT_SOURCES;
  const roleContextFiles = Object.entries(SYSTEM_CONFIG_DEFAULTS)
    .filter(([key]) => key.startsWith(`config/ai/${account}/context.d/`))
    .map(([key, text]) => ({
      name: key.slice(`config/ai/${account}/context.d/`.length),
      text: text.replaceAll("{{crew.username}}", "crew"),
    }));
  const files = new Map<string, string>([
    ...contextFiles("user").map(({ name, text }) => [`home/alex/context.d/${name}`, text] as const),
    ...Object.entries(homeFiles).map(([name, text]) => [`home/${account}/context.d/${name}`, text] as const),
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
      roleContext: { name: account, location: `/sys/config/ai/${account}/context.d`, files: roleContextFiles },
    },
    skills: {
      mode: "summary",
      entries: [...BUILTIN_SKILL_NAMES].sort().map((id) => {
        const file = readSystemSkillPath(`${SYSTEM_SKILLS_ROOT}/${id}/SKILL.md`);
        return { id, description: parseSkillMarkdown(file.kind === "file" ? file.content : "", id).description };
      }),
    },
    runtime: { date: "2026-01-01", timezone: "UTC" },
    ship: { handle: "preview", origin: "https://preview.ship.space", domain: "ship.space" },
    mailbox: { address: "preview@ship.space" },
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
  const providers = resolvePromptProviders().map((provider): PromptContextProvider => ({
    ...provider,
    async collect(assemblyInput: PromptAssemblyInput) {
      const collected = await provider.collect(assemblyInput);
      const contextRoot = provider.layer?.(assemblyInput) ?? undefined;
      const sourceScope = contextRoot?.key === "base" ? account : contextRoot?.key === "user" ? "user" : "system";
      for (const section of collected) {
        const path = `${sourceScope}/context.d/${section.name}`;
        const paths = catalog.some((source) => source.path === path) ? [path] : [];
        const previewSection: PreviewSection = { ...section, paths, provider: provider.name };
        if (contextRoot) previewSection.contextRoot = contextRoot;
        sections.push(previewSection);
      }
      return collected;
    },
  }));
  const snapshot = await assembleSystemPromptSnapshot(input, providers);
  return { ...snapshot, sections, catalog };
}
