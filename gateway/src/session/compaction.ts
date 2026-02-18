import type {
  Message,
  UserMessage,
  AssistantMessage,
} from "@mariozechner/pi-ai";
import { completeSimple, getModel } from "@mariozechner/pi-ai";
import type { CompactionConfig } from "../config";
import {
  estimateContextTokens,
  countImageBlocks,
  serializeMessagesForSummary,
  splitOldAndRecent,
  chunkMessages,
} from "./tokens";

export type CompactionResult = {
  /** Whether compaction actually ran. */
  compacted: boolean;
  /** Synthetic summary message to replace old messages, if compacted. */
  summaryMessage?: UserMessage;
  /** Messages that were compacted (for archival). */
  archivedMessages?: Message[];
  /** Messages kept verbatim (recent tail). */
  keptMessages?: Message[];
  /** Extracted memories (bullet list), if any. */
  memories?: string;
  /** How many summarization LLM calls were made. */
  summarizationCalls?: number;
  /** Which fallback tier was used: "full" | "partial" | "plaintext". */
  tier?: "full" | "partial" | "plaintext";
};

export type CompactionContext = {
  model: { provider: string; id: string };
  apiKey: string;
  contextWindow: number;
  config: CompactionConfig;
  /** Existing daily memory content, so the summarizer can avoid duplicating entries. */
  existingMemory?: string;
};

const SUMMARIZATION_SYSTEM_PROMPT = `You are condensing conversation history into a compact summary. Be thorough but concise. Preserve all information that would be needed to continue the conversation coherently.`;

function buildSummarizationUserPrompt(
  chunk: string,
  previousSummary: string | undefined,
  existingMemory: string | undefined,
): string {
  const parts: string[] = [];

  if (previousSummary) {
    parts.push(`<previous-summary>\n${previousSummary}\n</previous-summary>`);
  }

  if (existingMemory) {
    parts.push(
      `<existing-memories>\nThese memories have already been recorded. Do not duplicate them — only add genuinely new information.\n\n${existingMemory}\n</existing-memories>`,
    );
  }

  parts.push(`<conversation>\n${chunk}\n</conversation>`);

  parts.push(`Produce two sections:

<summary>
A concise summary preserving: decisions made, action items, open questions,
technical context, constraints, and current state of any ongoing work.
${previousSummary ? "Incorporate the previous summary — do not drop prior context." : ""}
</summary>

<memories>
Key durable facts worth remembering long-term. Only genuinely important,
stable information — not transient conversation details.
${existingMemory ? "Do not repeat entries already present in <existing-memories>." : ""}
- one bullet per memory
</memories>`);

  return parts.join("\n\n");
}

function parseSummarizationResponse(text: string): {
  summary: string;
  memories: string;
} {
  const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/);
  const memoriesMatch = text.match(/<memories>([\s\S]*?)<\/memories>/);

  return {
    summary: summaryMatch?.[1]?.trim() ?? text.trim(),
    memories: memoriesMatch?.[1]?.trim() ?? "",
  };
}

function extractTextFromResponse(response: AssistantMessage): string {
  if (!response.content) return "";
  return (response.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n");
}

/**
 * Summarize a single chunk with rolling context from prior chunks.
 * Returns the parsed summary and memories.
 */
async function summarizeChunk(
  chunk: Message[],
  previousSummary: string | undefined,
  ctx: CompactionContext,
): Promise<{ summary: string; memories: string }> {
  const serialized = serializeMessagesForSummary(chunk);
  const userPrompt = buildSummarizationUserPrompt(
    serialized,
    previousSummary,
    ctx.existingMemory,
  );

  const model = getModel(ctx.model.provider as any, ctx.model.id as any);
  if (!model) {
    throw new Error(
      `Compaction model not found: ${ctx.model.provider}/${ctx.model.id}`,
    );
  }

  const response = await completeSimple(
    model,
    {
      systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
    },
    { apiKey: ctx.apiKey },
  );

  const text = extractTextFromResponse(response);
  if (!text) {
    throw new Error("Summarization returned empty response");
  }

  return parseSummarizationResponse(text);
}

async function fullSummarization(
  chunks: Message[][],
  ctx: CompactionContext,
): Promise<{ summary: string; memories: string; calls: number }> {
  let rollingSummary: string | undefined;
  let accumulatedMemory = ctx.existingMemory ?? "";
  let allMemories: string[] = [];
  let calls = 0;

  for (const chunk of chunks) {
    const chunkCtx: CompactionContext = {
      ...ctx,
      existingMemory: accumulatedMemory || undefined,
    };
    const result = await summarizeChunk(chunk, rollingSummary, chunkCtx);
    rollingSummary = result.summary;
    if (result.memories) {
      allMemories.push(result.memories);
      // Accumulate so the next chunk sees what we already extracted
      accumulatedMemory = accumulatedMemory
        ? `${accumulatedMemory}\n${result.memories}`
        : result.memories;
    }
    calls++;
  }

  return {
    summary: rollingSummary ?? "",
    memories: allMemories.join("\n"),
    calls,
  };
}

async function partialSummarization(
  chunks: Message[][],
  ctx: CompactionContext,
): Promise<{ summary: string; memories: string; calls: number }> {
  let rollingSummary: string | undefined;
  let accumulatedMemory = ctx.existingMemory ?? "";
  let allMemories: string[] = [];
  let calls = 0;
  const halfWindow = ctx.contextWindow * 0.5;

  for (const chunk of chunks) {
    const chunkTokens = estimateContextTokens(chunk);
    if (chunkTokens > halfWindow) {
      // Skip oversized chunk — add a placeholder note
      const note = `[Large message block (~${Math.round(chunkTokens / 1000)}K tokens) omitted from summary]`;
      rollingSummary = rollingSummary ? `${rollingSummary}\n\n${note}` : note;
      continue;
    }

    const chunkCtx: CompactionContext = {
      ...ctx,
      existingMemory: accumulatedMemory || undefined,
    };
    const result = await summarizeChunk(chunk, rollingSummary, chunkCtx);
    rollingSummary = result.summary;
    if (result.memories) {
      allMemories.push(result.memories);
      accumulatedMemory = accumulatedMemory
        ? `${accumulatedMemory}\n${result.memories}`
        : result.memories;
    }
    calls++;
  }

  return {
    summary: rollingSummary ?? "",
    memories: allMemories.join("\n"),
    calls,
  };
}

function plaintextFallback(oldMessages: Message[]): {
  summary: string;
  memories: string;
  calls: number;
} {
  const imageCount = countImageBlocks(oldMessages);
  const imageNote = imageCount > 0 ? ` Included ${imageCount} image(s).` : "";
  return {
    summary: `[Context contained ${oldMessages.length} messages that were compacted. Summary unavailable due to size limits.${imageNote}]`,
    memories: "",
    calls: 0,
  };
}

/**
 * Run context compaction with the three-tier fallback chain:
 * 1. Full summarization
 * 2. Partial summarization (skip oversized chunks)
 * 3. Plain text fallback (no LLM call)
 */
export async function runCompaction(
  messages: Message[],
  ctx: CompactionContext,
): Promise<CompactionResult> {
  const { old, recent } = splitOldAndRecent(
    messages,
    ctx.config.keepRecentTokens,
  );

  if (old.length === 0) {
    return { compacted: false };
  }

  // Chunk budget: ~25% of context window per chunk
  const chunkBudget = Math.floor(ctx.contextWindow * 0.25);
  const chunks = chunkMessages(old, chunkBudget);

  const imageCount = countImageBlocks(old);
  const imageNote =
    imageCount > 0
      ? `\n\n[${imageCount} image(s) were present in the compacted history but could not be included in this summary.]`
      : "";

  // Tier 1: Full summarization
  let result: { summary: string; memories: string; calls: number };
  let tier: "full" | "partial" | "plaintext" = "full";

  try {
    result = await fullSummarization(chunks, ctx);
  } catch (fullErr) {
    console.warn(
      `[Compaction] Full summarization failed, trying partial:`,
      fullErr,
    );
    tier = "partial";

    // Tier 2: Partial summarization
    try {
      result = await partialSummarization(chunks, ctx);
    } catch (partialErr) {
      console.warn(
        `[Compaction] Partial summarization failed, using plaintext fallback:`,
        partialErr,
      );
      tier = "plaintext";

      // Tier 3: Plain text fallback
      result = plaintextFallback(old);
    }
  }

  // Build synthetic summary message
  const summaryText = `[Conversation summary from automatic context compaction]\n\n${result.summary}${imageNote}`;
  const summaryMessage: UserMessage = {
    role: "user",
    content: summaryText,
    timestamp: Date.now(),
  };

  return {
    compacted: true,
    summaryMessage,
    archivedMessages: old,
    keptMessages: recent,
    memories: result.memories || undefined,
    summarizationCalls: result.calls,
    tier,
  };
}

const MEMORY_EXTRACTION_SYSTEM_PROMPT = `You are extracting durable, long-term memories from a conversation that is about to be archived. Focus on facts, preferences, decisions, and context that would be valuable in future conversations.`;

function buildMemoryExtractionPrompt(
  conversation: string,
  existingMemory: string | undefined,
): string {
  const parts: string[] = [];

  if (existingMemory) {
    parts.push(
      `<existing-memories>\nThese memories have already been recorded. Do not duplicate them.\n\n${existingMemory}\n</existing-memories>`,
    );
  }

  parts.push(`<conversation>\n${conversation}\n</conversation>`);

  parts.push(`Extract key durable facts worth remembering long-term from this conversation.
Only genuinely important, stable information — not transient conversation details.
${existingMemory ? "Do not repeat entries already present in <existing-memories>." : ""}

<memories>
- one bullet per memory
</memories>`);

  return parts.join("\n\n");
}

/**
 * Extract memories from messages without producing a summary.
 * Used as a pre-reset step to preserve durable facts before the session
 * is archived and cleared.
 *
 * Chunks messages and extracts memories from each chunk sequentially,
 * accumulating extracted memories so later chunks can see earlier results.
 * Returns the combined extracted memories string, or empty string on failure.
 */
export async function extractMemoriesFromMessages(
  messages: Message[],
  ctx: CompactionContext,
): Promise<string> {
  if (messages.length === 0) return "";

  const chunkBudget = Math.floor(ctx.contextWindow * 0.25);
  const chunks = chunkMessages(messages, chunkBudget);
  const halfWindow = ctx.contextWindow * 0.5;

  let accumulatedMemory = ctx.existingMemory ?? "";
  const allMemories: string[] = [];

  const model = getModel(ctx.model.provider as any, ctx.model.id as any);
  if (!model) {
    console.error(
      `[Compaction] Memory extraction model not found: ${ctx.model.provider}/${ctx.model.id}`,
    );
    return "";
  }

  for (const chunk of chunks) {
    const chunkTokens = estimateContextTokens(chunk);
    if (chunkTokens > halfWindow) {
      // Skip oversized chunks — can't fit in a single extraction call
      continue;
    }

    try {
      const serialized = serializeMessagesForSummary(chunk);
      const userPrompt = buildMemoryExtractionPrompt(
        serialized,
        accumulatedMemory || undefined,
      );

      const response = await completeSimple(
        model,
        {
          systemPrompt: MEMORY_EXTRACTION_SYSTEM_PROMPT,
          messages: [
            { role: "user", content: userPrompt, timestamp: Date.now() },
          ],
        },
        { apiKey: ctx.apiKey },
      );

      const text = extractTextFromResponse(response);
      if (text) {
        const memoriesMatch = text.match(/<memories>([\s\S]*?)<\/memories>/);
        const memories = memoriesMatch?.[1]?.trim() ?? text.trim();
        if (memories) {
          allMemories.push(memories);
          accumulatedMemory = accumulatedMemory
            ? `${accumulatedMemory}\n${memories}`
            : memories;
        }
      }
    } catch (e) {
      console.warn(
        `[Compaction] Memory extraction failed for chunk, skipping:`,
        e,
      );
      // Continue with remaining chunks
    }
  }

  return allMemories.join("\n");
}
