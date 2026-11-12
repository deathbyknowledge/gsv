import { assembleSystemPromptSnapshot } from "../../workers/gateway/src/process/context/assembly";
import { resolvePromptProviders } from "../../workers/gateway/src/process/context/selection";
import type { PromptAssemblyInput, PromptAssemblySnapshot, PromptSection } from "../../workers/gateway/src/process/context/types";
import { SYSTEM_CONFIG_DEFAULTS } from "../../workers/gateway/src/kernel/config";
import { parseSkillMarkdown } from "../../workers/gateway/src/kernel/skills";
import { BUILTIN_SKILL_NAMES, SYSTEM_SKILLS_ROOT, readSystemSkillPath } from "../../workers/gateway/src/kernel/sys/builtin-skills";
import { contextFiles } from "../../workers/gateway/src/prompts/context";
import { shipContextFiles } from "../../workers/gateway/src/prompts/personal-intelligence";
import { PROMPT_SOURCES, type PromptSource } from "./prompt-sources";

export type PreviewAccount = "ship" | "crew";
type PreviewSection = PromptSection & { paths: string[]; provider: string };
type PromptPreview = PromptAssemblySnapshot & {
  sections: PreviewSection[];
  catalog: PromptSource[];
};

const SAMPLE_SHIP = { handle: "preview", origin: "https://preview.ship.space", domain: "ship.space" };
const SAMPLE_MAILBOX = { address: "preview@ship.space" };

// This fixture uses the production defaults and providers, with local sample identities.
// It never contacts a space or reads customer context. A draft catalog (paths laid out like
// `prompts/`) replaces the repository's standing files, so a proposed layout renders the same way.
export async function createPromptPreview(account: PreviewAccount, draft?: PromptSource[]): Promise<PromptPreview> {
  const systemContextFiles = draft ? draftFiles(draft, "system") : Object.entries(SYSTEM_CONFIG_DEFAULTS)
    .filter(([key]) => key.startsWith("config/ai/context.d/"))
    .map(([key, text]) => ({ name: key.slice("config/ai/context.d/".length), text }));
  const catalog = draft ?? PROMPT_SOURCES;
  const program = draft ? draftFiles(draft, account).map(withSampleValues)
    : account === "ship" ? shipContextFiles("crew") : contextFiles("crew");
  const owner = draft ? draftFiles(draft, "user").map(withSampleValues) : contextFiles("user");
  const files = new Map<string, string>([
    ...program.map(({ name, text }) => [`home/${account}/context.d/${name}`, text] as const),
    ...owner.map(({ name, text }) => [`home/alex/context.d/${name}`, text] as const),
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
    },
    skills: {
      mode: "summary",
      entries: [...BUILTIN_SKILL_NAMES].sort().map((id) => {
        const file = readSystemSkillPath(`${SYSTEM_SKILLS_ROOT}/${id}/SKILL.md`);
        return { id, description: parseSkillMarkdown(file.kind === "file" ? file.content : "", id).description };
      }),
    },
    runtime: { date: "2026-01-01", timezone: "UTC" },
    ship: SAMPLE_SHIP,
    mailbox: SAMPLE_MAILBOX,
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
        const path = `${sourceScope}/context.d/${section.name}`;
        const paths = catalog.some((source) => source.path === path) ? [path] : [];
        sections.push({ ...section, paths, provider: provider.name });
      }
      return collected;
    },
  }));
  const snapshot = await assembleSystemPromptSnapshot(input, providers);
  return { ...snapshot, sections, catalog };
}

function draftFiles(draft: PromptSource[], scope: string): Array<{ name: string; text: string }> {
  const prefix = `${scope}/context.d/`;
  return draft
    .filter((source) => source.path.startsWith(prefix))
    .map((source) => ({ name: source.path.slice(prefix.length), text: source.text }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

// 1.0 expands placeholders only in system files and fills the Crew name when seeding a home.
// A draft may move placeholder text into account files, so fill the same sample values there.
function withSampleValues(file: { name: string; text: string }) {
  const values = new Map([
    ["crew.username", "crew"],
    ["ship.handle", SAMPLE_SHIP.handle],
    ["ship.address", SAMPLE_SHIP.origin],
    ["ship.domain", SAMPLE_SHIP.domain],
    ["mailbox.address", SAMPLE_MAILBOX.address],
  ]);
  return {
    name: file.name,
    text: file.text.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (match, key: string) => values.get(key) ?? match),
  };
}
