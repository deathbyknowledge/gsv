import type {
  AssistantMessageEventStream,
  Context,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ParsedInferenceRequest } from "../domain";
import type { InferencePrice } from "../price-book";

export type ManagedProvider = {
  price: InferencePrice;
  stream(input: {
    request: ParsedInferenceRequest;
    context: Context;
    reasoning?: ThinkingLevel;
    attemptId: string;
    attemptOrdinal: number;
    signal: AbortSignal;
  }): Promise<AssistantMessageEventStream>;
};
