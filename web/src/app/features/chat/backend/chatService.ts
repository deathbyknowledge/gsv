import type { GSVClient } from "@humansandmachines/gsv/client";
import type {
  ProcAbortArgs,
  ProcAbortResult,
  ProcHistoryArgs,
  ProcHistoryResult,
  ProcListArgs,
  ProcMediaReadArgs,
  ProcMediaReadResult,
  ProcSendResult,
  ProcSpawnArgs,
  ProcSpawnResult,
} from "@humansandmachines/gsv/protocol";
import {
  normalizeHistory,
  normalizeProcessSummaries,
  normalizeSendPayload,
  type ChatHistory,
  type ChatProcessSummary,
  type ChatSendDraft,
} from "../domain/processes";

type ChatGsvClient = Pick<GSVClient, "proc">;

type FailureResult = { ok: false; error: string };

function throwIfFailed<T>(result: T | FailureResult): T {
  if (
    result &&
    typeof result === "object" &&
    "ok" in result &&
    result.ok === false
  ) {
    throw new Error(result.error || "GSV process request failed");
  }
  return result as T;
}

export async function listChatProcesses(
  client: ChatGsvClient,
  args: ProcListArgs = {},
): Promise<ChatProcessSummary[]> {
  const result = await client.proc.list(args);
  return normalizeProcessSummaries(result.processes);
}

export async function spawnChatProcess(
  client: ChatGsvClient,
  args: ProcSpawnArgs = {},
): Promise<Extract<ProcSpawnResult, { ok: true }>> {
  return throwIfFailed(await client.proc.spawn(args));
}

export async function sendChatMessage(
  client: ChatGsvClient,
  draft: ChatSendDraft,
): Promise<Extract<ProcSendResult, { ok: true }>> {
  return throwIfFailed(await client.proc.send(normalizeSendPayload(draft)));
}

export async function abortChatProcess(
  client: ChatGsvClient,
  args: ProcAbortArgs = {},
): Promise<Extract<ProcAbortResult, { ok: true }>> {
  return throwIfFailed(await client.proc.abort(args));
}

export async function getChatHistory(
  client: ChatGsvClient,
  args: ProcHistoryArgs = {},
): Promise<ChatHistory> {
  const result = throwIfFailed<Extract<ProcHistoryResult, { ok: true }>>(
    await client.proc.history(args),
  );
  return normalizeHistory(result);
}

export async function readChatProcessMedia(
  client: ChatGsvClient,
  args: ProcMediaReadArgs,
): Promise<Extract<ProcMediaReadResult, { ok: true }>> {
  return throwIfFailed(await client.proc.media.read(args));
}
