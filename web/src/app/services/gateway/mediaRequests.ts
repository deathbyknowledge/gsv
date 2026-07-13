import type { GSVClient } from "@humansandmachines/gsv/client";
import type {
  AiSpeechCreateArgs,
  AiSpeechCreateResult,
  AiTranscriptionCreateArgs,
  AiTranscriptionCreateResult,
} from "@humansandmachines/gsv/protocol";
import { frameBodyFromBlob, frameBodyToBlob } from "./frameBody";

type MediaRequestClient = Pick<GSVClient, "request">;

export type SpeechAudioResponse = {
  result: AiSpeechCreateResult;
  audio: Blob | null;
};

export async function requestAudioTranscription(
  client: MediaRequestClient,
  args: AiTranscriptionCreateArgs,
  audio: Blob,
  signal?: AbortSignal,
): Promise<AiTranscriptionCreateResult> {
  const response = await client.request("ai.transcription.create", args, {
    body: frameBodyFromBlob(audio),
    signal,
  });
  await response.body?.stream.cancel("Transcription response body is unsupported").catch(() => {});
  return response.data;
}

export async function requestSpeechAudio(
  client: MediaRequestClient,
  args: AiSpeechCreateArgs,
): Promise<SpeechAudioResponse> {
  const response = await client.request("ai.speech.create", args);
  const result = response.data;
  if (result.skipped || result.audio.size === 0) {
    await response.body?.stream.cancel("Speech response did not include audio").catch(() => {});
    return { result, audio: null };
  }
  if (!response.body) {
    throw new Error("Speech response did not include an audio body");
  }
  const audio = await frameBodyToBlob(response.body, {
    mimeType: result.audio.mimeType,
    expectedLength: result.audio.size,
    label: "Speech audio",
  });
  return { result, audio };
}
