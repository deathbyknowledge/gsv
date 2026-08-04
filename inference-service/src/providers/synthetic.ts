import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { SYNTHETIC_PRICE } from "../price-book";
import type { ManagedProvider } from "./types";

type SyntheticOptions = {
  delayMs: number;
  failFirstAttempt: boolean;
  throwRequestPrefix?: string;
};

export function createSyntheticProvider(options: SyntheticOptions): ManagedProvider {
  return {
    price: SYNTHETIC_PRICE,
    async stream(input): Promise<AssistantMessageEventStream> {
      if (
        input.attemptOrdinal === 1
        && options.throwRequestPrefix
        && input.request.logicalRequestId.startsWith(options.throwRequestPrefix)
      ) {
        throw new Error("Synthetic provider outcome is ambiguous");
      }
      const stream = createAssistantMessageEventStream();
      void emitSynthetic(stream, input.attemptOrdinal, input.signal, options);
      return stream;
    },
  };
}

async function emitSynthetic(
  stream: AssistantMessageEventStream,
  attemptOrdinal: number,
  signal: AbortSignal,
  options: SyntheticOptions,
): Promise<void> {
  const partial = message([], "pending", zeroUsage());
  stream.push({ type: "start", partial });
  try {
    await waitWithSignal(options.delayMs, signal);
    if (options.failFirstAttempt && attemptOrdinal === 1) {
      stream.push({
        type: "error",
        reason: "error",
        error: message([], "error", usage(10, 0, 0), "Synthetic retryable provider error"),
      });
      return;
    }
    const text = "synthetic managed response";
    const started = message([{ type: "text", text: "" }], "pending", zeroUsage());
    stream.push({ type: "text_start", contentIndex: 0, partial: started });
    const partialText = message([{ type: "text", text }], "pending", zeroUsage());
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: partialText });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: partialText });
    stream.push({
      type: "done",
      reason: "stop",
      message: message([{ type: "text", text }], "stop", usage(100, 20, 40)),
    });
  } catch {
    stream.push({
      type: "error",
      reason: "aborted",
      error: message([], "aborted", zeroUsage(), "Managed inference cancelled"),
    });
  }
}

function message(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  messageUsage: AssistantMessage["usage"],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "synthetic",
    provider: "synthetic",
    model: "synthetic-v1",
    usage: messageUsage,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function usage(input: number, cacheRead: number, output: number): AssistantMessage["usage"] {
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens: input + cacheRead + output,
    cost: {
      input: input * SYNTHETIC_PRICE.cacheMissInputMicrounitsPerMillionTokens / 1e12,
      output: output * SYNTHETIC_PRICE.outputMicrounitsPerMillionTokens / 1e12,
      cacheRead: cacheRead * SYNTHETIC_PRICE.cacheHitInputMicrounitsPerMillionTokens / 1e12,
      cacheWrite: 0,
      total: (
        input * SYNTHETIC_PRICE.cacheMissInputMicrounitsPerMillionTokens
        + output * SYNTHETIC_PRICE.outputMicrounitsPerMillionTokens
        + cacheRead * SYNTHETIC_PRICE.cacheHitInputMicrounitsPerMillionTokens
      ) / 1e12,
    },
  };
}

function zeroUsage(): AssistantMessage["usage"] {
  return usage(0, 0, 0);
}

async function waitWithSignal(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("cancelled"));
    };
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    timeout = setTimeout(finish, delayMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}
