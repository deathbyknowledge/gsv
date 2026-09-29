import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@humansandmachines/gsv/protocol";
import { requestBinding } from "../src/executor/bodies";
import { transcribeAudioWithWorkersAi } from "../src/media/transcription";

describe("request-scoped native binding", () => {
  it.each(["request", "transcription"] as const)("forwards %s cancellation to native execution", async (source) => {
    const request = new AbortController();
    const transcription = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const run = vi.fn((_model: string, _input: JsonObject, options?: { signal?: AbortSignal }) => {
      providerSignal = options?.signal;
      return new Promise<never>(() => {});
    });
    const binding = requestBinding({ aiGatewayLogId: null, run }, request.signal);
    const pending = transcribeAudioWithWorkersAi(binding, {
      model: "@cf/openai/whisper-large-v3-turbo",
      data: "AQID",
      signal: transcription.signal,
    });
    const rejection = expect(pending).rejects.toThrow("cancelled");
    (source === "request" ? request : transcription).abort(new Error("cancelled"));
    await rejection;
    expect(run).toHaveBeenCalledOnce();
    expect(providerSignal?.aborted).toBe(true);
    expect(providerSignal?.reason.message).toBe("cancelled");
  });
});
