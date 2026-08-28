import type { AssistantMessage } from "@earendil-works/pi-ai";

const CONTEXT_EPOCH_ID = Symbol("gsv.contextEpochId");

type EpochTaggedAssistantMessage = AssistantMessage & {
  [CONTEXT_EPOCH_ID]?: string;
};

export function tagAssistantContextEpoch(
  message: AssistantMessage,
  contextEpochId: string | undefined,
): void {
  if (!contextEpochId) return;
  Object.defineProperty(message, CONTEXT_EPOCH_ID, {
    value: contextEpochId,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

export function assistantContextEpochId(
  message: AssistantMessage,
): string | undefined {
  // SAFETY: tagAssistantContextEpoch is the only writer and stores a string under this symbol.
  return (message as EpochTaggedAssistantMessage)[CONTEXT_EPOCH_ID];
}
