import type { Message } from "@mariozechner/pi-ai";
import {
  resolvePartialArchiveKey,
  resolveSessionArchiveKey,
  resolveSessionArchivePrefix,
} from "./paths";

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
  agentId: string,
  options?: { spaceId?: string; threadId?: string },
): string {
  return resolveSessionArchiveKey({
    agentId,
    sessionId,
    spaceId: options?.spaceId,
    threadId: options?.threadId,
  });
}

/**
 * Archive a session's messages to R2
 *
 * @param storage - R2 bucket
 * @param sessionId - The unique session ID being archived
 * @param messages - Messages to archive
 * @param tokens - Token usage for this session
 * @param agentId - Agent ID
 * @returns The R2 key where archived
 */
export async function archiveSession(
  storage: R2Bucket,
  sessionKey: string, // Kept for compatibility, but not used in path
  sessionId: string,
  messages: Message[],
  tokens: { input: number; output: number; total: number },
  agentId: string,
  options?: { spaceId?: string; threadId?: string },
): Promise<string> {
  if (messages.length === 0) {
    return "";
  }

  const jsonl = messagesToJsonl(messages);
  const compressed = await gzipCompress(jsonl);

  const key = resolveSessionTranscriptKey(sessionId, agentId, options);
  await storage.put(key, compressed, {
    customMetadata: {
      sessionKey,
      sessionId,
      agentId,
      spaceId: options?.spaceId ?? "",
      threadId: options?.threadId ?? "",
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
  agentId: string,
  options?: { spaceId?: string; threadId?: string },
): Promise<Message[] | null> {
  const key = resolveSessionTranscriptKey(sessionId, agentId, options);
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
  agentId: string,
  options?: { spaceId?: string; threadId?: string },
): Promise<boolean> {
  const key = resolveSessionTranscriptKey(sessionId, agentId, options);
  await storage.delete(key);
  return true;
}

export async function listArchivedSessions(
  storage: R2Bucket,
  agentId: string,
  options?: { spaceId?: string; threadId?: string },
): Promise<ArchivedSessionInfo[]> {
  const prefix = resolveSessionArchivePrefix({
    agentId,
    spaceId: options?.spaceId,
    threadId: options?.threadId,
  });
  const list = await storage.list({ prefix });

  const sessions: ArchivedSessionInfo[] = [];
  for (const obj of list.objects) {
    // Extract sessionId from key:
    // - agents/{agentId}/sessions/{sessionId}.jsonl.gz (legacy)
    // - spaces/{spaceId}/agents/{agentId}/threads/{threadId}/archives/{sessionId}.jsonl.gz
    const match = obj.key.match(/\/sessions\/(.+)\.jsonl\.gz$/);
    const threadMatch = obj.key.match(/\/archives\/(.+)\.jsonl\.gz$/);
    const sessionId = match?.[1] ?? threadMatch?.[1];
    if (!sessionId) continue;
    const meta = obj.customMetadata || {};

    sessions.push({
      sessionId,
      archivedAt:
        parseInt(meta.archivedAt || "0", 10) || obj.uploaded.getTime(),
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
  agentId: string,
  options?: { spaceId?: string; threadId?: string },
): Promise<string> {
  if (messages.length === 0) {
    return "";
  }

  const jsonl = messagesToJsonl(messages);
  const compressed = await gzipCompress(jsonl);

  const key = resolvePartialArchiveKey({
    agentId,
    sessionId,
    partNumber,
    spaceId: options?.spaceId,
    threadId: options?.threadId,
  });
  await storage.put(key, compressed, {
    customMetadata: {
      sessionKey,
      sessionId,
      agentId,
      spaceId: options?.spaceId ?? "",
      threadId: options?.threadId ?? "",
      partNumber: partNumber.toString(),
      messageCount: messages.length.toString(),
      archivedAt: Date.now().toString(),
    },
  });

  return key;
}
