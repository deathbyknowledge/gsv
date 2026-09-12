import type {
  AssistantMessage, ImageContent, Message, TextContent, ThinkingContent, ToolCall, ToolResultMessage, UserMessage,
} from "@humansandmachines/gsv/services/inference-context";
import type { InteractionOrigin, ProcHistoryEvent, ProcHistoryRecordData } from "@humansandmachines/gsv/protocol";
import { tagAssistantContextIdentity } from "../context-message-metadata";
import { type StoredProcessMedia } from "../media";
import { buildFallbackMediaBlocks, describeStoredProcessMedia } from "./media-renderer";
import { normalizeAssistantStopReason, usageStateToPiUsage } from "../storage/metadata-codec";
import type { MessageMetadata } from "../storage/records";
import { renderHistoryEvent } from "./event-renderer";
import { formatInteractionOriginForContext, formatReplyDestinationForContext } from "../../prompts/context-origin";
export { formatInteractionOriginForContext, formatReplyDestinationForContext } from "../../prompts/context-origin";
import { MAX_PROCESS_MEDIA_READ_BYTES } from "../internal/lifecycle";

/** One original message and its ordered typed members share a model-context position. */
export type ModelHistoryGroup = {
  messageId: number;
  generation: number;
  runId: string | null;
  createdAt: number;
  records: readonly [ProcHistoryRecordData, ...ProcHistoryRecordData[]];
  metadata: MessageMetadata | null;
  origin?: InteractionOrigin;
  /** Existing history retains source bytes that its inferred payload cannot reconstruct. */
  compatibility: {
    text: string;
    // Inferred envelope media may never have been presented; promotion does not change that.
    media: StoredProcessMedia[];
    mediaJson: string | null;
    hasMedia: boolean;
    isError: boolean;
    legacyImageContent: ToolResultMessage["content"] | null;
  };
};

export type ModelHistoryRenderOptions = {
  /** Only usage confirmed against this exact prompt epoch is reusable. */
  contextEpochId?: string;
  /** Only usage confirmed against this exact system-prompt/tool shape is reusable. */
  generationContextId?: string;
  /** A run without an input record supplies its current origin explicitly; null means the default Process destination. */
  currentRunOrigin?: InteractionOrigin | null;
};

export function renderModelHistory(
  groups: readonly ModelHistoryGroup[],
  options?: ModelHistoryRenderOptions,
): Message[] {
  return groups.map((group) => renderModelHistoryGroup(group, options)).filter((message) => message !== null);
}

export async function renderContextHistory(
  groups: readonly ModelHistoryGroup[],
  options: ModelHistoryRenderOptions,
  hydrate: (
    text: string,
    media: string,
    budget: { remainingBytes: number },
  ) => Promise<(TextContent | ImageContent)[]>,
): Promise<Message[]> {
  const visibleGroups = groups.filter(hasModelHistoryMessage);
  const messages = renderModelHistory(visibleGroups, options);
  const budget = { remainingBytes: MAX_PROCESS_MEDIA_READ_BYTES };
  for (let index = 0; index < visibleGroups.length; index += 1) {
    const group = visibleGroups[index]!;
    if (!group.compatibility.hasMedia) continue;
    // Existing histories hydrate every media-bearing group, including assistant groups.
    // Their reads consume the shared budget even when their content is not projected.
    const primary = group.records[0];
    const text = primary.kind === "message"
      ? selectedMessageText(group.compatibility.text, primary.payload.selectedTarget)
      : group.compatibility.text;
    const content = await hydrate(text, group.compatibility.mediaJson!, budget);
    const message = messages[index]!;
    if (primary.kind === "message") {
      messages[index] = { role: "user", content, timestamp: group.createdAt };
    } else if (message.role === "toolResult") {
      messages[index] = { ...message, content };
    }
  }
  const previousReplyDestinationKey = annotateContextOrigins(visibleGroups, messages);
  const orderedMessages = orderMessagesForProvider(messages);
  if (options.currentRunOrigin !== undefined && previousReplyDestinationKey !== undefined) {
    const destination = formatReplyDestinationForContext(options.currentRunOrigin ?? undefined);
    if (destination.key !== previousReplyDestinationKey) {
      orderedMessages.push({
        role: "user",
        content: formatContextOriginLines(null, false, destination, true),
        timestamp: orderedMessages.at(-1)?.timestamp ?? 0,
      });
    }
  }
  return orderedMessages;
}

function annotateContextOrigins(groups: readonly ModelHistoryGroup[], messages: Message[]): string | undefined {
  let previousSource: string | null | undefined;
  let previousReplyDestinationKey: string | undefined;
  const seenRunIds = new Set<string>();
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!;
    const ownsDistinctRun = Boolean(group.runId && !seenRunIds.has(group.runId));
    if (group.runId) seenRunIds.add(group.runId);
    const primary = group.records[0];
    if (primary.kind !== "message" && primary.kind !== "event") continue;
    const schedule = primary.kind === "event" && primary.payload.kind === "schedule.fired"
      ? primary.payload.payload : undefined;
    const origin = schedule
      ? { kind: "scheduler" as const, scheduleId: schedule.scheduleId, replyTo: schedule.replyTo }
      : group.origin;

    const source = formatInteractionOriginForContext(origin);
    const shouldRenderSource = !schedule && source !== null && source !== previousSource;
    if (primary.kind === "message" || source !== null) previousSource = source;

    const replyDestination = ownsDistinctRun || schedule?.replyTo ? formatReplyDestinationForContext(origin) : null;
    const shouldRenderReplyDestination =
      replyDestination !== null && replyDestination.key !== previousReplyDestinationKey;
    if (replyDestination) previousReplyDestinationKey = replyDestination.key;
    if (schedule?.replyTo) continue;

    const message = messages[index];
    if (message?.role !== "user" || (!shouldRenderSource && !shouldRenderReplyDestination)) continue;
    const annotations = formatContextOriginLines(
      source, shouldRenderSource, replyDestination, shouldRenderReplyDestination,
    );
    messages[index] = primary.kind === "event"
      ? renderModelEvent(primary.payload, group.createdAt, annotations)
      : prefixUserMessageContent(message, annotations);
  }
  return previousReplyDestinationKey;
}

export function renderModelHistoryGroup(
  group: ModelHistoryGroup,
  options?: ModelHistoryRenderOptions,
): Message | null {
  if (!hasModelHistoryMessage(group)) return null;
  const primary = group.records[0];
  switch (primary.kind) {
    case "message": {
      const media = group.compatibility.media;
      const text = selectedMessageText(primary.payload.text, primary.payload.selectedTarget);
      return {
        role: "user",
        content: media.length === 0
          ? text
          : buildFallbackUserContent(text, media),
        timestamp: group.createdAt,
      };
    }
    case "event": return renderModelEvent(primary.payload, group.createdAt);
    case "note":
    case "call":
      return assistantHistoryMessage(group, options);
    case "result":
      return toolResultHistoryMessage(group, primary.payload);
  }
}

function hasModelHistoryMessage(group: ModelHistoryGroup): boolean {
  const primary = group.records[0];
  if (primary.kind === "event") return primary.payload.audience !== "person" && primary.payload.kind !== "process.approval";
  if (primary.kind === "message") return primary.payload.direction === "in";
  return true;
}

export function renderModelEvent(event: ProcHistoryEvent, timestamp: number, annotations?: string): UserMessage {
  return { role: "user", content: ["[GSV EVENT]", ...(annotations ? [annotations] : []), renderHistoryEvent(event)].join("\n"), timestamp };
}

function assistantHistoryMessage(
  group: ModelHistoryGroup,
  options: ModelHistoryRenderOptions | undefined,
): AssistantMessage {
  const content: (TextContent | ThinkingContent | ToolCall)[] = [];
  const note = group.records.find((record) => record.kind === "note");
  const metadata = group.metadata;
  const { provider = null, contextEpochId, generationContextId } = metadata ?? {};
  const { api = "", provider: providerName = "", model = "", stopReason } = provider ?? {};
  if (note) {
    content.push(...note.payload.thinking);
    if (note.payload.text) content.push({ type: "text", text: note.payload.text });
  }
  for (const record of group.records) {
    if (record.kind !== "call") continue;
    const call: ToolCall = {
      type: "toolCall",
      id: record.payload.callId,
      name: record.payload.tool,
      arguments: record.payload.args,
    };
    if (record.payload.thoughtSignature !== undefined) {
      call.thoughtSignature = record.payload.thoughtSignature;
    }
    content.push(call);
  }
  const message: AssistantMessage = {
    role: "assistant",
    content,
    api,
    provider: providerName,
    model,
    usage: usageStateToPiUsage(reusableAssistantUsage(metadata, options)),
    stopReason: normalizeAssistantStopReason(stopReason),
    timestamp: group.createdAt,
  };
  if (provider?.responseModel) message.responseModel = provider.responseModel;
  if (provider?.responseId) message.responseId = provider.responseId;
  tagAssistantContextIdentity(message, contextEpochId, generationContextId);
  return message;
}

function reusableAssistantUsage(
  metadata: MessageMetadata | null,
  options: ModelHistoryRenderOptions | undefined,
) {
  const epochMatches =
    options?.contextEpochId === undefined || metadata?.contextEpochId === options.contextEpochId;
  const generationMatches =
    options?.generationContextId === undefined ||
    metadata?.generationContextId === options.generationContextId;
  return epochMatches && generationMatches ? metadata?.usage : undefined;
}

function toolResultHistoryMessage(
  group: ModelHistoryGroup,
  result: Extract<ProcHistoryRecordData, { kind: "result" }>["payload"],
): ToolResultMessage {
  const { text, media, isError, legacyImageContent } = group.compatibility;
  return {
    role: "toolResult",
    toolCallId: result.callId,
    toolName: result.tool,
    content: legacyImageContent ?? [
      { type: "text", text },
      ...buildFallbackMediaBlocks(media),
    ],
    isError,
    timestamp: group.createdAt,
  };
}

function buildFallbackUserContent(text: string, media: StoredProcessMedia[]): TextContent[] {
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

export function prefixUserMessageContent(message: UserMessage, prefix: string): UserMessage {
  if (!Array.isArray(message.content)) {
    return { ...message, content: `${prefix}\n${message.content}` };
  }

  const content = [...message.content];
  const first = content[0];
  if (first?.type === "text") {
    content[0] = {
      ...first,
      text: `${prefix}\n${first.text}`,
    };
  } else {
    content.unshift({ type: "text", text: prefix });
  }

  return {
    ...message,
    content,
  };
}

export function orderMessagesForProvider(messages: Message[]): Message[] {
  const ordered: Message[] = [];
  type PendingToolBlock = {
    expected: Set<string>;
    deferred: Message[];
  };
  type MessageOrderState = { pendingToolBlock: PendingToolBlock | null; };
  const state: MessageOrderState = { pendingToolBlock: null };

  const append = (message: Message): void => {
    const pendingToolBlock = state.pendingToolBlock;
    if (pendingToolBlock) {
      // Providers require tool results to immediately follow the assistant tool-call message.
      if (message.role === "toolResult" && pendingToolBlock.expected.has(message.toolCallId)) {
        pendingToolBlock.expected.delete(message.toolCallId);
        ordered.push(message);

        if (pendingToolBlock.expected.size === 0) {
          const deferred = pendingToolBlock.deferred;
          state.pendingToolBlock = null;
          for (const deferredMessage of deferred) {
            append(deferredMessage);
          }
        }
        return;
      }

      pendingToolBlock.deferred.push(message);
      return;
    }

    ordered.push(message);
    const toolCallIds = message.role === "assistant"
      ? message.content.flatMap((block) => block.type === "toolCall" ? [block.id] : [])
      : [];
    if (toolCallIds.length > 0) {
      state.pendingToolBlock = {
        expected: new Set(toolCallIds),
        deferred: [],
      };
    }
  };

  for (const message of messages) {
    append(message);
  }

  if (state.pendingToolBlock) {
    ordered.push(...state.pendingToolBlock.deferred);
  }

  return ordered;
}

function selectedMessageText(text: string, selectedTarget: string | undefined): string {
  return selectedTarget === undefined ? text : `[Selected target: ${selectedTarget}]\n${text}`;
}

function formatContextOriginLines(
  source: string | null,
  renderSource: boolean,
  replyDestination: ReturnType<typeof formatReplyDestinationForContext> | null,
  renderReplyDestination: boolean,
): string {
  const lines: string[] = [];
  if (renderSource && source !== null) lines.push(`[From: ${source}]`);
  if (renderReplyDestination && replyDestination) {
    lines.push(`[Directed endpoint: ${replyDestination.description}.]`);
  }
  return lines.join("\n");
}
