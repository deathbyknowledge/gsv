import type { GSVClient } from "@humansandmachines/gsv/client";
import { GsvClientError } from "@humansandmachines/gsv/client";
import type { TerminalCommandInput, TerminalTarget, TerminalTranscriptEntry } from "../domain/models";
import {
  normalizeCommandInput,
  normalizeTerminalTargets,
  normalizeTranscriptEntry,
} from "../domain/normalization";

export type TerminalClient = Pick<GSVClient, "call" | "request">;

type TerminalRequestArgs = {
  input: string;
  sessionId?: string;
  target?: string;
  cwd?: string;
  timeout?: number;
  background?: boolean;
  yieldMs?: number;
};

export async function listTerminalTargets(client: TerminalClient): Promise<TerminalTarget[]> {
  const payload = await client.call<unknown>("sys.target.list", { includeOffline: true });
  return normalizeTerminalTargets(payload);
}

export async function executeTerminalCommand(
  client: TerminalClient,
  command: TerminalCommandInput,
  signal?: AbortSignal,
): Promise<TerminalTranscriptEntry> {
  const input = normalizeCommandInput(command);
  if (!input.input && !input.sessionId) {
    throw new Error("Command is required.");
  }

  const requestArgs: TerminalRequestArgs = { input: input.input };
  if (input.sessionId) {
    requestArgs.sessionId = input.sessionId;
  } else if (input.target !== "gsv") {
    requestArgs.target = input.target;
  }
  if (!input.sessionId && input.cwd) {
    requestArgs.cwd = input.cwd;
  }
  if (!input.sessionId && input.timeoutMs !== null) {
    requestArgs.timeout = input.timeoutMs;
  }
  if (!input.sessionId && input.background) {
    requestArgs.background = true;
  }
  if (input.yieldMs !== null) requestArgs.yieldMs = input.yieldMs;

  const startedAt = Date.now();
  const response = await client.request("shell.exec", requestArgs, { signal });
  return normalizeTranscriptEntry(response.data, startedAt, input);
}

export async function cancelTerminalCommand(client: TerminalClient, sessionId: string, signal?: AbortSignal) {
  try {
    return (await client.request("shell.cancel", { sessionId }, { signal })).data;
  } catch (error) {
    if (error instanceof GsvClientError && error.code === 400 && error.message.endsWith("does not implement shell.cancel")) {
      throw new Error("Update GSV on this computer to use Stop.");
    }
    throw error;
  }
}
