/**
 * R2 Storage helpers for GSV
 *
 * Storage structure (matching clawdbot pattern):
 * gsv-storage/
 * └── agents/{agentId}/
 *     └── sessions/
 *         └── {sessionId}.jsonl.gz    # Archived transcript for a reset session
 *
 * Skills (future - markdown files like clawdbot):
 * gsv-storage/
 * └── skills/{skillName}/
 *     └── SKILL.md                    # Skill definition with YAML frontmatter
 *
 * Note: Session metadata (settings, token counts, etc.) is stored in DO storage.
 * R2 is only used for archiving transcripts on reset and skills.
 */

import type { Message } from "@mariozechner/pi-ai";

// Default agent ID (GSV currently doesn't support multi-agent)
const DEFAULT_AGENT_ID = "default";

// Types for archived session info (stored in DO state, not R2)
export type ArchivedSessionInfo = {
  sessionId: string;
  archivedAt: number;
  messageCount: number;
  tokens: {
    input: number;
    output: number;
    total: number;
  };
};

// Skill metadata from YAML frontmatter (clawdbot-compatible)
export type SkillMetadata = {
  name: string;
  description: string;
  homepage?: string;
  gsv?: CustomMetadata;
  clawdbot?: CustomMetadata;
};

export type CustomMetadata = {
    emoji?: string;
    requires?: {
      bins?: string[];
      anyBins?: string[];
      env?: string[];
      config?: string[];
    };
    install?: Array<{
      id?: string;
      kind: "brew" | "node" | "go" | "uv" | "download";
      label?: string;
      bins?: string[];
      formula?: string;
      package?: string;
    }>;
}

// Parsed skill entry (content + metadata)
export type SkillEntry = {
  name: string;
  content: string; // Full markdown content
  metadata: SkillMetadata;
};

/**
 * Compress data using gzip
 */
async function gzipCompress(data: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const input = encoder.encode(data);

  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(input);
  writer.close();

  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result.buffer;
}

async function gzipDecompress(data: ArrayBuffer): Promise<string> {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(data);
  writer.close();

  const chunks: Uint8Array[] = [];
  const reader = ds.readable.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  const decoder = new TextDecoder();
  return decoder.decode(result);
}

function messagesToJsonl(messages: Message[]): string {
  return messages.map((m) => JSON.stringify(m)).join("\n");
}

function jsonlToMessages(jsonl: string): Message[] {
  return jsonl
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function resolveSessionTranscriptKey(
  sessionId: string,
  agentId: string = DEFAULT_AGENT_ID
): string {
  return `agents/${agentId}/sessions/${sessionId}.jsonl.gz`;
}

/**
 * Archive a session's messages to R2
 *
 * @param storage - R2 bucket
 * @param sessionId - The unique session ID being archived
 * @param messages - Messages to archive
 * @param tokens - Token usage for this session
 * @param agentId - Agent ID (defaults to "default")
 * @returns The R2 key where archived
 */
export async function archiveSession(
  storage: R2Bucket,
  sessionKey: string, // Kept for compatibility, but not used in path
  sessionId: string,
  messages: Message[],
  tokens: { input: number; output: number; total: number },
  agentId: string = DEFAULT_AGENT_ID
): Promise<string> {
  if (messages.length === 0) {
    return "";
  }

  const jsonl = messagesToJsonl(messages);
  const compressed = await gzipCompress(jsonl);

  const key = resolveSessionTranscriptKey(sessionId, agentId);
  await storage.put(key, compressed, {
    customMetadata: {
      sessionKey,
      sessionId,
      agentId,
      messageCount: messages.length.toString(),
      archivedAt: Date.now().toString(),
      inputTokens: tokens.input.toString(),
      outputTokens: tokens.output.toString(),
      totalTokens: tokens.total.toString(),
    },
  });

  return key;
}

export async function getArchivedTranscript(
  storage: R2Bucket,
  sessionId: string,
  agentId: string = DEFAULT_AGENT_ID
): Promise<Message[] | null> {
  const key = resolveSessionTranscriptKey(sessionId, agentId);
  const obj = await storage.get(key);

  if (!obj) {
    return null;
  }

  const compressed = await obj.arrayBuffer();
  const jsonl = await gzipDecompress(compressed);
  return jsonlToMessages(jsonl);
}

export async function deleteArchivedSession(
  storage: R2Bucket,
  sessionId: string,
  agentId: string = DEFAULT_AGENT_ID
): Promise<boolean> {
  const key = resolveSessionTranscriptKey(sessionId, agentId);
  await storage.delete(key);
  return true;
}

export async function listArchivedSessions(
  storage: R2Bucket,
  agentId: string = DEFAULT_AGENT_ID
): Promise<ArchivedSessionInfo[]> {
  const prefix = `agents/${agentId}/sessions/`;
  const list = await storage.list({ prefix });

  const sessions: ArchivedSessionInfo[] = [];
  for (const obj of list.objects) {
    // Extract sessionId from key: agents/{agentId}/sessions/{sessionId}.jsonl.gz
    const match = obj.key.match(/\/sessions\/(.+)\.jsonl\.gz$/);
    if (!match) continue;

    const sessionId = match[1];
    const meta = obj.customMetadata || {};

    sessions.push({
      sessionId,
      archivedAt: parseInt(meta.archivedAt || "0", 10) || obj.uploaded.getTime(),
      messageCount: parseInt(meta.messageCount || "0", 10),
      tokens: {
        input: parseInt(meta.inputTokens || "0", 10),
        output: parseInt(meta.outputTokens || "0", 10),
        total: parseInt(meta.totalTokens || "0", 10),
      },
    });
  }

  return sessions;
}

/**
 * Archive partial messages (for compact operation)
 * Creates a partial archive with the same sessionId but different path
 */
export async function archivePartialMessages(
  storage: R2Bucket,
  sessionKey: string,
  sessionId: string,
  messages: Message[],
  partNumber: number,
  agentId: string = DEFAULT_AGENT_ID
): Promise<string> {
  if (messages.length === 0) {
    return "";
  }

  const jsonl = messagesToJsonl(messages);
  const compressed = await gzipCompress(jsonl);

  // Partial archives get a -part{N} suffix
  const key = `agents/${agentId}/sessions/${sessionId}-part${partNumber}.jsonl.gz`;
  await storage.put(key, compressed, {
    customMetadata: {
      sessionKey,
      sessionId,
      agentId,
      partNumber: partNumber.toString(),
      messageCount: messages.length.toString(),
      archivedAt: Date.now().toString(),
    },
  });

  return key;
}

function parseSkillFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const frontmatter: Record<string, string> = {};
  let body = content;

  // Check for YAML frontmatter (--- delimited)
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (match) {
    const yaml = match[1];
    body = match[2];

    // Simple YAML parsing (key: value pairs)
    for (const line of yaml.split("\n")) {
      const keyValue = line.match(/^(\w+):\s*(.*)$/);
      if (keyValue) {
        frontmatter[keyValue[1]] = keyValue[2].trim();
      }
    }
  }

  return { frontmatter, body };
}

function resolveSkillKey(skillName: string): string {
  return `skills/${skillName}/SKILL.md`;
}

export async function saveSkill(
  storage: R2Bucket,
  skillName: string,
  content: string
): Promise<void> {
  const key = resolveSkillKey(skillName);
  await storage.put(key, content, {
    customMetadata: {
      name: skillName,
      updatedAt: Date.now().toString(),
    },
  });
}

export async function loadSkill(
  storage: R2Bucket,
  skillName: string
): Promise<SkillEntry | null> {
  const key = resolveSkillKey(skillName);
  const obj = await storage.get(key);

  if (!obj) {
    return null;
  }

  const content = await obj.text();
  const { frontmatter, body } = parseSkillFrontmatter(content);

  let clawdbotMeta: SkillMetadata["clawdbot"];
  try {
    if (frontmatter.metadata) {
      clawdbotMeta = JSON.parse(frontmatter.metadata)?.clawdbot;
    }
  } catch {
    // Ignore malformed metadata
  }

  return {
    name: frontmatter.name || skillName,
    content,
    metadata: {
      name: frontmatter.name || skillName,
      description: frontmatter.description || "",
      homepage: frontmatter.homepage,
      clawdbot: clawdbotMeta,
    },
  };
}

export async function listSkills(storage: R2Bucket): Promise<string[]> {
  const list = await storage.list({ prefix: "skills/" });

  const skillNames = new Set<string>();
  for (const obj of list.objects) {
    const match = obj.key.match(/^skills\/([^/]+)\//);
    if (match) {
      skillNames.add(match[1]);
    }
  }

  return Array.from(skillNames);
}

export async function deleteSkill(
  storage: R2Bucket,
  skillName: string
): Promise<boolean> {
  const key = resolveSkillKey(skillName);
  await storage.delete(key);

  // TODO: delete any reference files in the skill directory
  return true;
}
