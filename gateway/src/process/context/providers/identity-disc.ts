import { homeKnowledgeRepoRef, workspaceRepoRef } from "../../../fs/ripgit/repos";
import type { PromptContextProvider, PromptRipgitClient, PromptSection } from "../types";
import type { RipgitRepoRef } from "../../../fs/ripgit/client";

const TEXT_DECODER = new TextDecoder();
const MAX_DISC_CONTEXT_CHARS = 2_400;
const MAX_DISC_ENTRIES = 12;

type IdentityDiscPreview = {
  summary: string[];
  entries: IdentityDiscPreviewEntry[];
};

type IdentityDiscPreviewEntry = {
  id: string;
  kind: string;
  scope: string;
  summary: string;
  tags: string[];
  source?: string;
  confidence?: string;
  updatedAt?: string;
};

export function createIdentityDiscProvider(): PromptContextProvider {
  return {
    name: "identity.disc",
    async collect(input) {
      const sections: PromptSection[] = [];

      if (input.ripgit) {
        const homeRepo = homeKnowledgeRepoRef(input.identity.username);
        const homeDisc = await readIdentityDisc(input.ripgit, homeRepo, "identity.idz");
        if (homeDisc) {
          sections.push({
            name: "identity.disc:home",
            text: renderIdentityDiscPreview(homeDisc, "~/identity.idz", "Home Identity Disc"),
          });
        }

        if (input.identity.workspaceId) {
          const workspaceRepo = workspaceRepoRef(
            input.identity.workspaceId,
            input.identity.username,
          );
          const workspaceDisc = await readIdentityDisc(input.ripgit, workspaceRepo, ".gsv/identity.idz");
          if (workspaceDisc) {
            sections.push({
              name: "identity.disc:workspace",
              text: renderIdentityDiscPreview(
                workspaceDisc,
                `/workspaces/${input.identity.workspaceId}/.gsv/identity.idz`,
                "Workspace Identity Disc",
              ),
            });
          }
        }

        return sections;
      }

      const homeKey = input.identity.home.replace(/^\//, "");
      const object = await input.storage.get(`${homeKey}/identity.idz`);
      if (!object) {
        return [];
      }
      const text = (await object.text()).trim();
      if (!text) {
        return [];
      }
      sections.push({
        name: "identity.disc:home",
        text: renderIdentityDiscPreview(parseIdentityDiscPreview(text), "~/identity.idz", "Home Identity Disc"),
      });
      return sections;
    },
  };
}

async function readIdentityDisc(
  ripgit: PromptRipgitClient,
  repo: RipgitRepoRef,
  path: string,
): Promise<IdentityDiscPreview | null> {
  const result = await ripgit.readPath(repo, path);
  if (result.kind !== "file") {
    return null;
  }
  const text = TEXT_DECODER.decode(result.bytes).trim();
  if (!text) {
    return null;
  }
  return parseIdentityDiscPreview(text);
}

function parseIdentityDiscPreview(text: string): IdentityDiscPreview {
  const summary: string[] = [];
  const entries: IdentityDiscPreviewEntry[] = [];

  for (const rawLine of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("@summary")) {
      const item = unquote(line.slice("@summary".length).trim());
      if (item) {
        summary.push(item);
      }
      continue;
    }
    if (line.startsWith("@entry")) {
      const attrs = parseAttributes(line.slice("@entry".length));
      const id = attrs.id?.trim();
      const entrySummary = attrs.summary?.trim();
      if (!id || !entrySummary) {
        continue;
      }
      entries.push({
        id,
        summary: entrySummary,
        kind: attrs.kind?.trim() || "note",
        scope: attrs.scope?.trim() || "process",
        tags: parseTags(attrs.tags),
        source: optionalAttr(attrs.source),
        confidence: optionalAttr(attrs.confidence),
        updatedAt: optionalAttr(attrs.updated),
      });
    }
  }

  return { summary, entries };
}

function renderIdentityDiscPreview(
  preview: IdentityDiscPreview,
  path: string,
  title: string,
): string {
  const lines = [
    `${title}: ${path}`,
    "The prompt includes only summaries and an index. Read the .idz file before relying on omitted detail.",
  ];

  if (preview.summary.length > 0) {
    lines.push("", "Summary:");
    for (const item of preview.summary.slice(0, 6)) {
      lines.push(`- ${item}`);
    }
  }

  const entries = [...preview.entries].sort(compareEntryRecency).slice(0, MAX_DISC_ENTRIES);
  if (entries.length > 0) {
    lines.push("", "Index:");
    for (const entry of entries) {
      lines.push(renderEntry(entry));
    }
  }

  if (preview.entries.length > entries.length) {
    lines.push(`- ... ${preview.entries.length - entries.length} more entries. Search or read ${path} for more.`);
  }

  return clampText(lines.join("\n"), MAX_DISC_CONTEXT_CHARS);
}

function renderEntry(entry: IdentityDiscPreviewEntry): string {
  const tags = entry.tags.length > 0 ? ` #${entry.tags.join(" #")}` : "";
  const confidence = entry.confidence ? ` ${entry.confidence}` : "";
  const source = entry.source ? ` <${entry.source}>` : "";
  return `- [${entry.id}] ${entry.kind}/${entry.scope}${confidence}${tags}${source}: ${entry.summary}`;
}

function parseAttributes(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let index = 0;

  while (index < input.length) {
    while (input[index] === " " || input[index] === "\t") {
      index += 1;
    }
    if (index >= input.length) {
      break;
    }

    const keyStart = index;
    while (index < input.length && !["=", " ", "\t"].includes(input[index] ?? "")) {
      index += 1;
    }
    const key = input.slice(keyStart, index).trim();
    while (input[index] === " " || input[index] === "\t") {
      index += 1;
    }
    if (!key || input[index] !== "=") {
      break;
    }
    index += 1;
    while (input[index] === " " || input[index] === "\t") {
      index += 1;
    }

    const parsed = parseAttributeValue(input, index);
    attrs[key] = parsed.value;
    index = parsed.nextIndex;
  }

  return attrs;
}

function parseAttributeValue(input: string, start: number): { value: string; nextIndex: number } {
  if (input[start] !== "\"") {
    let index = start;
    while (index < input.length && input[index] !== " " && input[index] !== "\t") {
      index += 1;
    }
    return { value: input.slice(start, index), nextIndex: index };
  }

  let value = "";
  let index = start + 1;
  while (index < input.length) {
    const char = input[index];
    if (char === "\\") {
      const next = input[index + 1];
      if (next === "n") {
        value += "\n";
        index += 2;
        continue;
      }
      if (next) {
        value += next;
        index += 2;
        continue;
      }
    }
    if (char === "\"") {
      return { value, nextIndex: index + 1 };
    }
    value += char;
    index += 1;
  }

  return { value, nextIndex: index };
}

function unquote(value: string): string {
  if (value.startsWith("\"") && value.endsWith("\"")) {
    return parseAttributeValue(value, 0).value;
  }
  return value;
}

function parseTags(value: string | undefined): string[] {
  return value?.split(",").map((tag) => tag.trim()).filter(Boolean) ?? [];
}

function optionalAttr(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function compareEntryRecency(left: IdentityDiscPreviewEntry, right: IdentityDiscPreviewEntry): number {
  return timestamp(right.updatedAt) - timestamp(left.updatedAt) || left.id.localeCompare(right.id);
}

function timestamp(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const suffix = "\n- ... identity disc context truncated; read the .idz file for more.";
  return `${text.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd()}${suffix}`;
}
