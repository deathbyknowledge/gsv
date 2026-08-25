export type IdentityDiscEntryKind =
  | "fact"
  | "preference"
  | "decision"
  | "procedure"
  | "source"
  | "todo"
  | "event"
  | "note"
  | (string & {});

export type IdentityDiscEntryScope =
  | "home"
  | "workspace"
  | "package"
  | "process"
  | "target"
  | "system"
  | (string & {});

export type IdentityDiscConfidence =
  | "low"
  | "medium"
  | "high"
  | "verified"
  | (string & {});

export type IdentityDiscEntry = {
  id: string;
  kind: IdentityDiscEntryKind;
  scope: IdentityDiscEntryScope;
  summary: string;
  body?: string;
  tags?: string[];
  source?: string;
  confidence?: IdentityDiscConfidence;
  createdAt?: string;
  updatedAt?: string;
  attributes?: Record<string, string>;
};

export type IdentityDisc = {
  title?: string;
  owner?: string;
  updatedAt?: string;
  summary: string[];
  entries: IdentityDiscEntry[];
  attributes?: Record<string, string>;
};

export type IdentityDiscParseResult = {
  disc: IdentityDisc;
  diagnostics: IdentityDiscDiagnostic[];
};

export type IdentityDiscDiagnostic = {
  line: number;
  message: string;
};

export type IdentityDiscRenderOptions = {
  title?: string;
  query?: string;
  maxEntries?: number;
  maxChars?: number;
  includeBody?: boolean;
};

export type IdentityDiscSearchOptions = {
  limit?: number;
};

type EntryDraft = {
  entry: IdentityDiscEntry;
  bodyLines: string[];
};

const FORMAT_HEADER = "# idz/v1";
const DEFAULT_MAX_RENDER_ENTRIES = 12;
const DEFAULT_MAX_RENDER_CHARS = 2_400;

export function createIdentityDisc(input: Partial<IdentityDisc> = {}): IdentityDisc {
  return {
    title: input.title,
    owner: input.owner,
    updatedAt: input.updatedAt,
    summary: [...(input.summary ?? [])],
    entries: [...(input.entries ?? [])],
    attributes: input.attributes ? { ...input.attributes } : undefined,
  };
}

export function parseIdentityDisc(text: string): IdentityDisc {
  return parseIdentityDiscWithDiagnostics(text).disc;
}

export function parseIdentityDiscWithDiagnostics(text: string): IdentityDiscParseResult {
  const disc = createIdentityDisc();
  const diagnostics: IdentityDiscDiagnostic[] = [];
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let draft: EntryDraft | null = null;

  function finishDraft(): void {
    if (!draft) {
      return;
    }
    const body = trimBlankLines(draft.bodyLines).join("\n");
    if (body) {
      draft.entry.body = body;
    }
    disc.entries.push(draft.entry);
    draft = null;
  }

  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (trimmed === "" && draft) {
      draft.bodyLines.push("");
      return;
    }
    if (trimmed === "" || trimmed === FORMAT_HEADER) {
      return;
    }
    if (trimmed.startsWith("#") && !draft) {
      return;
    }
    if (trimmed.startsWith("@disc")) {
      finishDraft();
      const attrs = parseAttributes(trimmed.slice("@disc".length), lineNumber, diagnostics);
      applyDiscAttributes(disc, attrs);
      return;
    }
    if (trimmed.startsWith("@summary")) {
      finishDraft();
      const summary = unquote(trimmed.slice("@summary".length).trim());
      if (summary) {
        disc.summary.push(summary);
      }
      return;
    }
    if (trimmed.startsWith("@entry")) {
      finishDraft();
      const attrs = parseAttributes(trimmed.slice("@entry".length), lineNumber, diagnostics);
      const id = attrs.id?.trim();
      const summary = attrs.summary?.trim();
      if (!id) {
        diagnostics.push({ line: lineNumber, message: "@entry requires id" });
      }
      if (!summary) {
        diagnostics.push({ line: lineNumber, message: "@entry requires summary" });
      }
      draft = {
        entry: {
          id: id || `entry-${lineNumber}`,
          kind: attrs.kind?.trim() || "note",
          scope: attrs.scope?.trim() || "process",
          summary: summary || "",
          tags: parseTags(attrs.tags),
          source: optionalAttribute(attrs.source),
          confidence: optionalAttribute(attrs.confidence),
          createdAt: optionalAttribute(attrs.created),
          updatedAt: optionalAttribute(attrs.updated),
          attributes: remainingAttributes(attrs, [
            "id",
            "kind",
            "scope",
            "summary",
            "tags",
            "source",
            "confidence",
            "created",
            "updated",
          ]),
        },
        bodyLines: [],
      };
      if (draft.entry.tags?.length === 0) {
        delete draft.entry.tags;
      }
      if (Object.keys(draft.entry.attributes ?? {}).length === 0) {
        delete draft.entry.attributes;
      }
      return;
    }

    if (draft) {
      draft.bodyLines.push(line);
      return;
    }

    diagnostics.push({ line: lineNumber, message: "ignored line outside an @entry block" });
  });

  finishDraft();
  return { disc, diagnostics };
}

export function serializeIdentityDisc(disc: IdentityDisc): string {
  const lines: string[] = [FORMAT_HEADER];
  const discAttrs = {
    ...disc.attributes,
    title: disc.title,
    owner: disc.owner,
    updated: disc.updatedAt,
  };
  const discLine = formatDirective("@disc", discAttrs);
  if (discLine) {
    lines.push(discLine);
  }

  for (const summary of disc.summary) {
    const text = summary.trim();
    if (text) {
      lines.push(`@summary ${quote(text)}`);
    }
  }

  for (const entry of disc.entries) {
    lines.push("");
    lines.push(formatEntryDirective(entry));
    if (entry.body?.trim()) {
      lines.push(entry.body.trim());
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function upsertIdentityDiscEntry(
  disc: IdentityDisc,
  entry: IdentityDiscEntry,
  now: Date | string = new Date(),
): IdentityDisc {
  const updatedAt = typeof now === "string" ? now : now.toISOString();
  const normalized: IdentityDiscEntry = {
    ...entry,
    id: entry.id.trim(),
    summary: entry.summary.trim(),
    updatedAt: entry.updatedAt ?? updatedAt,
    tags: entry.tags?.map((tag) => tag.trim()).filter(Boolean),
  };
  if (!normalized.id) {
    throw new Error("Identity disc entry id is required");
  }
  if (!normalized.summary) {
    throw new Error("Identity disc entry summary is required");
  }
  if (normalized.tags?.length === 0) {
    delete normalized.tags;
  }

  const entries = [...disc.entries];
  const index = entries.findIndex((candidate) => candidate.id === normalized.id);
  if (index >= 0) {
    entries[index] = {
      ...entries[index],
      ...normalized,
      createdAt: normalized.createdAt ?? entries[index].createdAt,
      updatedAt,
    };
  } else {
    entries.push({
      ...normalized,
      createdAt: normalized.createdAt ?? updatedAt,
      updatedAt,
    });
  }

  return {
    ...disc,
    entries,
    updatedAt,
  };
}

export function searchIdentityDisc(
  disc: IdentityDisc,
  query: string,
  options: IdentityDiscSearchOptions = {},
): IdentityDiscEntry[] {
  const terms = tokenize(query);
  if (terms.length === 0) {
    return mostRecentEntries(disc.entries).slice(0, options.limit ?? disc.entries.length);
  }

  const scored = disc.entries
    .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || compareEntryRecency(left.entry, right.entry));

  return scored.slice(0, options.limit ?? scored.length).map((item) => item.entry);
}

export function renderIdentityDiscContext(
  disc: IdentityDisc,
  options: IdentityDiscRenderOptions = {},
): string {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_RENDER_ENTRIES;
  const maxChars = options.maxChars ?? DEFAULT_MAX_RENDER_CHARS;
  const entries = options.query
    ? searchIdentityDisc(disc, options.query, { limit: maxEntries })
    : mostRecentEntries(disc.entries).slice(0, maxEntries);
  const lines: string[] = [
    options.title ?? disc.title ?? "Identity Disc",
  ];

  if (disc.summary.length > 0) {
    lines.push("Summary:");
    for (const item of disc.summary) {
      lines.push(`- ${item}`);
    }
  }

  if (entries.length > 0) {
    lines.push("Index:");
    for (const entry of entries) {
      lines.push(renderEntryIndexLine(entry));
      if (options.includeBody && entry.body?.trim()) {
        lines.push(indent(entry.body.trim(), "  "));
      }
    }
  }

  return clampText(lines.join("\n"), maxChars);
}

function applyDiscAttributes(disc: IdentityDisc, attrs: Record<string, string>): void {
  disc.title = optionalAttribute(attrs.title) ?? disc.title;
  disc.owner = optionalAttribute(attrs.owner) ?? disc.owner;
  disc.updatedAt = optionalAttribute(attrs.updated) ?? disc.updatedAt;
  const rest = remainingAttributes(attrs, ["title", "owner", "updated"]);
  if (rest && Object.keys(rest).length > 0) {
    disc.attributes = { ...(disc.attributes ?? {}), ...rest };
  }
}

function formatEntryDirective(entry: IdentityDiscEntry): string {
  return formatDirective("@entry", {
    ...entry.attributes,
    id: entry.id,
    kind: entry.kind,
    scope: entry.scope,
    summary: entry.summary,
    tags: entry.tags?.join(","),
    source: entry.source,
    confidence: entry.confidence,
    created: entry.createdAt,
    updated: entry.updatedAt,
  }) ?? "@entry";
}

function formatDirective(prefix: string, attrs: Record<string, string | undefined>): string | null {
  const parts = Object.entries(attrs)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
    .map(([key, value]) => `${key}=${quote(value)}`);
  if (parts.length === 0) {
    return null;
  }
  return `${prefix} ${parts.join(" ")}`;
}

function parseAttributes(
  input: string,
  line: number,
  diagnostics: IdentityDiscDiagnostic[],
): Record<string, string> {
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
      diagnostics.push({ line, message: `invalid attribute near "${input.slice(keyStart).trim()}"` });
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

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, "\\\"")}"`;
}

function unquote(value: string): string {
  if (value.startsWith("\"") && value.endsWith("\"")) {
    return parseAttributeValue(value, 0).value;
  }
  return value;
}

function parseTags(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  return value.split(",").map((tag) => tag.trim()).filter(Boolean);
}

function optionalAttribute(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function remainingAttributes(
  attrs: Record<string, string>,
  known: string[],
): Record<string, string> | undefined {
  const knownSet = new Set(known);
  const rest: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (!knownSet.has(key)) {
      rest[key] = value;
    }
  }
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") {
    start += 1;
  }
  while (end > start && lines[end - 1].trim() === "") {
    end -= 1;
  }
  return lines.slice(start, end);
}

function tokenize(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9_-]+/).filter(Boolean);
}

function scoreEntry(entry: IdentityDiscEntry, terms: string[]): number {
  const fields = [
    { text: entry.id, weight: 3 },
    { text: entry.summary, weight: 5 },
    { text: entry.tags?.join(" ") ?? "", weight: 4 },
    { text: entry.source ?? "", weight: 2 },
    { text: entry.body ?? "", weight: 1 },
  ];
  let score = 0;
  for (const term of terms) {
    for (const field of fields) {
      if (field.text.toLowerCase().includes(term)) {
        score += field.weight;
      }
    }
  }
  return score;
}

function mostRecentEntries(entries: IdentityDiscEntry[]): IdentityDiscEntry[] {
  return [...entries].sort(compareEntryRecency);
}

function compareEntryRecency(left: IdentityDiscEntry, right: IdentityDiscEntry): number {
  return timestamp(right) - timestamp(left) || left.id.localeCompare(right.id);
}

function timestamp(entry: IdentityDiscEntry): number {
  const value = entry.updatedAt ?? entry.createdAt;
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function renderEntryIndexLine(entry: IdentityDiscEntry): string {
  const tags = entry.tags?.length ? ` #${entry.tags.join(" #")}` : "";
  const confidence = entry.confidence ? ` ${entry.confidence}` : "";
  const source = entry.source ? ` <${entry.source}>` : "";
  return `- [${entry.id}] ${entry.kind}/${entry.scope}${confidence}${tags}${source}: ${entry.summary}`;
}

function indent(text: string, prefix: string): string {
  return text.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const suffix = "\n- ... identity disc truncated; inspect the .idz file for more.";
  return `${text.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd()}${suffix}`;
}
