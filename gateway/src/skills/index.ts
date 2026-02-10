export type CustomMetadata = {
  emoji?: string;
  requires?: {
    bins?: string[];
    anyBins?: string[];
    env?: string[];
    config?: string[];
    hostRoles?: string[];
    capabilities?: string[];
    anyCapabilities?: string[];
  };
  install?: Array<{
    id?: string;
    kind: "brew" | "node" | "go" | "uv" | "download";
    label?: string;
    bins?: string[];
    formula?: string;
    package?: string;
  }>;
};

export type SkillMetadata = {
  name: string;
  description: string;
  homepage?: string;
  gsv?: CustomMetadata;
  clawdbot?: CustomMetadata;
};

export type SkillEntry = {
  name: string;
  content: string;
  metadata: SkillMetadata;
};

export type SkillSummary = {
  name: string;
  description: string;
  location: string;
  always?: boolean;
  metadata?: {
    gsv?: CustomMetadata;
    clawdbot?: CustomMetadata;
  };
};

type Frontmatter = Record<string, unknown>;

export function parseFrontmatter(
  content: string,
): { frontmatter: Frontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const frontmatter: Frontmatter = {};
  const yamlLines = match[1].split("\n");
  for (const line of yamlLines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;

    const key = line.slice(0, colonIdx).trim();
    let value: unknown = line.slice(colonIdx + 1).trim();
    if (value === "true") {
      value = true;
    } else if (value === "false") {
      value = false;
    }
    frontmatter[key] = value;
  }

  return { frontmatter, body: match[2] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(frontmatter: Frontmatter, key: string): string | undefined {
  const value = frontmatter[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readBoolean(
  frontmatter: Frontmatter,
  key: string,
): boolean | undefined {
  const value = frontmatter[key];
  return typeof value === "boolean" ? value : undefined;
}

function readMetadataJson(
  frontmatter: Frontmatter,
): { gsv?: CustomMetadata; clawdbot?: CustomMetadata } {
  const raw = frontmatter.metadata;
  if (typeof raw !== "string" || raw.length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return {};
    }

    return {
      gsv: isRecord(parsed.gsv) ? (parsed.gsv as CustomMetadata) : undefined,
      clawdbot: isRecord(parsed.clawdbot)
        ? (parsed.clawdbot as CustomMetadata)
        : undefined,
    };
  } catch {
    return {};
  }
}

export function parseSkillEntry(skillName: string, content: string): SkillEntry {
  const { frontmatter } = parseFrontmatter(content);
  const resolvedName = readString(frontmatter, "name") || skillName;
  const metadataJson = readMetadataJson(frontmatter);

  return {
    name: resolvedName,
    content,
    metadata: {
      name: resolvedName,
      description: readString(frontmatter, "description") || "",
      homepage: readString(frontmatter, "homepage"),
      gsv: metadataJson.gsv,
      clawdbot: metadataJson.clawdbot,
    },
  };
}

function getSkillNameFromKey(key: string): string | null {
  if (!key.endsWith("/SKILL.md")) {
    return null;
  }

  const parts = key.split("/");
  if (parts.length < 2) {
    return null;
  }

  return parts[parts.length - 2] || null;
}

export function extractSkillDescription(content: string): string {
  const { body } = parseFrontmatter(content);
  const lines = body.trim().split("\n");

  let i = 0;
  while (i < lines.length && lines[i].startsWith("#")) i++;
  while (i < lines.length && !lines[i].trim()) i++;

  const descLines: string[] = [];
  while (i < lines.length && lines[i].trim()) {
    descLines.push(lines[i].trim());
    i++;
  }

  return descLines.join(" ").slice(0, 200);
}

async function loadSkillSummaryFromKey(
  bucket: R2Bucket,
  key: string,
): Promise<{ skillName: string; summary: SkillSummary } | null> {
  const skillName = getSkillNameFromKey(key);
  if (!skillName) {
    return null;
  }

  const object = await bucket.get(key);
  if (!object) {
    return null;
  }

  const content = await object.text();
  const { frontmatter } = parseFrontmatter(content);
  const metadata = readMetadataJson(frontmatter);
  return {
    skillName,
    summary: {
      name: readString(frontmatter, "name") || skillName,
      description:
        readString(frontmatter, "description") ||
        extractSkillDescription(content),
      location: key,
      always: readBoolean(frontmatter, "always"),
      metadata,
    },
  };
}

export async function listWorkspaceSkills(
  bucket: R2Bucket,
  agentId: string,
): Promise<SkillSummary[]> {
  const skills: SkillSummary[] = [];
  const agentSkillNames = new Set<string>();

  const agentSkills = await bucket.list({ prefix: `agents/${agentId}/skills/` });
  for (const obj of agentSkills.objects) {
    const loaded = await loadSkillSummaryFromKey(bucket, obj.key);
    if (!loaded) continue;

    agentSkillNames.add(loaded.skillName);
    skills.push(loaded.summary);
  }

  const globalSkills = await bucket.list({ prefix: "skills/" });
  for (const obj of globalSkills.objects) {
    const loaded = await loadSkillSummaryFromKey(bucket, obj.key);
    if (!loaded || agentSkillNames.has(loaded.skillName)) continue;

    skills.push(loaded.summary);
  }

  return skills;
}

export function resolveGlobalSkillKey(skillName: string): string {
  return `skills/${skillName}/SKILL.md`;
}

export async function listGlobalSkillNames(bucket: R2Bucket): Promise<string[]> {
  const list = await bucket.list({ prefix: "skills/" });
  const skillNames = new Set<string>();

  for (const obj of list.objects) {
    const skillName = getSkillNameFromKey(obj.key);
    if (skillName) {
      skillNames.add(skillName);
    }
  }

  return Array.from(skillNames);
}
