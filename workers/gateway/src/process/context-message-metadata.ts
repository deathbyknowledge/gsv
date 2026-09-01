import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { stableOpaqueId } from "../shared/stable-id";

const CONTEXT_EPOCH_ID = Symbol("gsv.contextEpochId");
const GENERATION_CONTEXT_ID = Symbol("gsv.generationContextId");

type ContextTaggedAssistantMessage = AssistantMessage & {
  [CONTEXT_EPOCH_ID]?: string;
  [GENERATION_CONTEXT_ID]?: string;
};

export async function deriveGenerationContextId(
  contextEpochId: string,
  systemPrompt: string,
  tools: Context["tools"],
): Promise<string> {
  return await stableOpaqueId("generation-context", [
    contextEpochId,
    systemPrompt,
    JSON.stringify(tools ?? []),
  ]);
}

export function tagAssistantContextIdentity(
  message: AssistantMessage,
  contextEpochId: string | undefined,
  generationContextId: string | undefined,
): void {
  if (contextEpochId) {
    defineIdentity(message, CONTEXT_EPOCH_ID, contextEpochId);
  }
  if (generationContextId) {
    defineIdentity(message, GENERATION_CONTEXT_ID, generationContextId);
  }
}

export function assistantContextEpochId(
  message: AssistantMessage,
): string | undefined {
  // SAFETY: tagAssistantContextIdentity is the only writer and stores a string under this symbol.
  return (message as ContextTaggedAssistantMessage)[CONTEXT_EPOCH_ID];
}

export function assistantGenerationContextId(
  message: AssistantMessage,
): string | undefined {
  // SAFETY: tagAssistantContextIdentity is the only writer and stores a string under this symbol.
  return (message as ContextTaggedAssistantMessage)[GENERATION_CONTEXT_ID];
}

function defineIdentity(
  message: AssistantMessage,
  key: symbol,
  value: string,
): void {
  Object.defineProperty(message, key, {
    value,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}
