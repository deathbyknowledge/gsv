/** Assistant metadata and fallback media projection codecs. */

import type { TextContent } from "@earendil-works/pi-ai";
import { buildFallbackMediaBlocks, describeStoredProcessMedia, parseStoredProcessMedia } from "../media";
import { z } from "zod";
import { assistantMessageMetaSchema, toolCallSchema } from "./validation";
import type { AssistantMessageMeta } from "./records";

export function parseAssistantMessageMeta(raw: string | null): AssistantMessageMeta {
  if (!raw) {
    return {};
  }

  let parsed: z.input<typeof assistantMessageMetaSchema>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  const legacyToolCalls = z.array(toolCallSchema).safeParse(parsed);
  if (legacyToolCalls.success) {
    return { toolCalls: legacyToolCalls.data };
  }
  const metadata = assistantMessageMetaSchema.safeParse(parsed);
  return metadata.success ? metadata.data : {};
}

export function buildFallbackUserContent(
  text: string,
  media: ReturnType<typeof parseStoredProcessMedia>,
): TextContent[] {
  const content: TextContent[] = [];
  if (text.trim().length > 0) {
    content.push({ type: "text", text });
  }

  const fallbackBlocks = buildFallbackMediaBlocks(media);
  if (fallbackBlocks.length > 0) {
    content.push(...fallbackBlocks);
  }

  if (content.length === 0) {
    content.push({
      type: "text",
      text: media.map((item) => describeStoredProcessMedia(item)).join("\n"),
    });
  }

  return content;
}

export function stringifyAssistantMessageMeta(
  meta: AssistantMessageMeta,
): string | undefined {
  const thinking = meta.thinking?.length ? meta.thinking : undefined;
  const toolCalls = meta.toolCalls?.length ? meta.toolCalls : undefined;

  if (!thinking && !toolCalls) {
    return undefined;
  }
  if (!thinking && toolCalls) {
    return JSON.stringify(toolCalls);
  }

  return JSON.stringify({
    thinking,
    toolCalls,
  });
}
