import type { GSVClient } from "@humansandmachines/gsv/client";
import type { TerminalCommandInput, TerminalTarget, TerminalTranscriptEntry } from "../domain/models";
import {
  normalizeCommandInput,
  normalizeTerminalTargets,
  normalizeTranscriptEntry,
} from "../domain/normalization";

export type TerminalClient = Pick<GSVClient, "call">;

export async function listTerminalTargets(client: TerminalClient): Promise<TerminalTarget[]> {
  const payload = await client.call<unknown>("sys.device.list", { includeOffline: true });
  return normalizeTerminalTargets(payload);
}

export async function executeTerminalCommand(
  client: TerminalClient,
  command: TerminalCommandInput,
): Promise<TerminalTranscriptEntry> {
  const input = normalizeCommandInput(command);
  if (!input.input) {
    throw new Error("Command is required.");
  }

  const requestArgs: Record<string, unknown> = { input: input.input };
  if (input.target !== "gsv") {
    requestArgs.target = input.target;
  }
  if (input.cwd) {
    requestArgs.cwd = input.cwd;
  }
  if (input.timeoutMs !== null) {
    requestArgs.timeout = input.timeoutMs;
  }
  if (input.background) {
    requestArgs.background = true;
    if (input.yieldMs !== null) {
      requestArgs.yieldMs = input.yieldMs;
    }
  }

  const startedAt = Date.now();
  const payload = await client.call<unknown>("shell.exec", requestArgs);
  return normalizeTranscriptEntry(payload, startedAt, input);
}
