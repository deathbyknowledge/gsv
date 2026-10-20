import type { GSVClient } from "@humansandmachines/gsv/client";
import { GsvClientError } from "@humansandmachines/gsv/client";
import { z } from "zod";
import { TerminalNoteError, type TerminalCommandInput, type TerminalTarget, type TerminalTranscriptEntry } from "../domain/models";
import {
  normalizeCommandInput,
  normalizeTerminalTargets,
  normalizeTranscriptEntry,
} from "../domain/normalization";

export type TerminalClient = Pick<GSVClient, "call" | "request">;

type TerminalRequestArgs = {
  input: string;
  sessionId?: string;
  start?: boolean;
  target?: string;
  cwd?: string;
  timeout?: number;
  background?: boolean;
  yieldMs?: number;
};

const rejectedStartSchema = z.object({ shellStart: z.literal("rejected") });

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
  if (!input.input && (!input.sessionId || input.start)) {
    throw new TerminalNoteError("commandRequired");
  }

  const requestArgs: TerminalRequestArgs = { input: input.input };
  if (input.sessionId) {
    requestArgs.sessionId = input.sessionId;
  }
  if (input.start) requestArgs.start = true;
  const starting = input.start || !input.sessionId;
  if (starting && input.target !== "gsv") {
    requestArgs.target = input.target;
  }
  if (starting && input.cwd) {
    requestArgs.cwd = input.cwd;
  }
  if (starting && input.timeoutMs !== null) {
    requestArgs.timeout = input.timeoutMs;
  }
  if (starting && input.background) {
    requestArgs.background = true;
  }
  if (input.yieldMs !== null) requestArgs.yieldMs = input.yieldMs;

  const startedAt = Date.now();
  try {
    const response = await client.request("shell.exec", requestArgs, { signal });
    return normalizeTranscriptEntry(response.data, startedAt, input);
  } catch (error) {
    if (error instanceof GsvClientError) {
      if (input.start) {
        const legacyDaemon = error.message === `Unknown shell session: ${input.sessionId}`;
        if (legacyDaemon) {
          return { ...normalizeTranscriptEntry({ status: "failed", error: "", output: "" }, startedAt, input), note: "updateShip" };
        }
        if (rejectedStartSchema.safeParse(error.details).success) {
          return normalizeTranscriptEntry({ status: "failed", error: error.message, output: "" }, startedAt, input);
        }
      } else if (!input.sessionId) {
        // A sessionless command leaves nothing behind to poll or cancel, so a
        // rejected request is its terminal outcome rather than an uncertain
        // start to be recovered. There is no marker to wait for either: the
        // Kernel attaches shellStart "rejected" only to a start:true frame.
        // Cancellation rejects with the abort reason rather than a
        // GsvClientError, so Stop still owns its own outcome.
        return normalizeTranscriptEntry({ status: "failed", error: error.message, output: "" }, startedAt, input);
      }
    }
    throw error;
  }
}

export async function cancelTerminalCommand(client: TerminalClient, sessionId: string, signal?: AbortSignal) {
  try {
    return (await client.request("shell.cancel", { sessionId }, { signal })).data;
  } catch (error) {
    if (error instanceof GsvClientError && error.code === 400 && error.message.endsWith("does not implement shell.cancel")) {
      throw new TerminalNoteError("updateShipToStop");
    }
    throw error;
  }
}
