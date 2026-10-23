import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { GSVClient } from "@humansandmachines/gsv/client";
import type { ProcHilArgs, ProcHilRequest, ProcHistoryArgs, ProcHistoryResult } from "@humansandmachines/gsv/protocol";
import { decideChatHil, getChatHistory } from "../../../services/chat/backend/chatService";
import { normalizeHilRequest } from "../../../services/chat/domain/hil";

export type ShipApprovalClient = {
  onSignal: GSVClient["onSignal"];
  proc: Pick<GSVClient["proc"], "hil"> & { history(args?: ProcHistoryArgs): Promise<ProcHistoryResult> };
};

export type ShipApproval = {
  request: ProcHilRequest | null;
  deciding: boolean;
  error: string | null;
  decide(decision: ProcHilArgs["decision"], remember?: boolean): Promise<void>;
};

/**
 * Follows the Ship's pending approval from the same signals Chat's transcript uses:
 * a request replaces any earlier one; the run moving on (another client answered),
 * finishing, or the process exiting clears it. Signals from another run are ignored.
 */
export function nextShipApproval(current: ProcHilRequest | null, pid: string, signal: string, payload: unknown): ProcHilRequest | null {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  if (record?.pid !== pid) return current;
  if (signal === "proc.run.hil.requested") return normalizeHilRequest(payload) ?? current;
  if (signal === "process.exit") return null;
  if (!current) return null;
  if (typeof record.runId === "string" && record.runId !== current.runId) return current;
  switch (signal) {
    case "proc.run.started":
    case "proc.run.retrying":
    case "proc.run.output":
    case "proc.run.tool.started":
    case "proc.run.finished":
      return null;
    default:
      return current;
  }
}

/**
 * The Ship's pending approval for app-wide surfaces. `observe` keeps the Ship's live
 * run signals flowing while no transcript is open; history hydrates a request that
 * was already waiting on first connect and after every reconnect.
 */
export function useShipApproval({ client, connected, shipPid, observe }: {
  client: ShipApprovalClient;
  connected: boolean;
  shipPid: string | null;
  observe: (pid: string) => () => void;
}): ShipApproval {
  const [request, setRequest] = useState<ProcHilRequest | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signals = useRef(0);

  useEffect(() => {
    setRequest(null);
    setError(null);
    if (!connected || !shipPid) return;
    const release = observe(shipPid);
    const unsubscribe = client.onSignal((signal, payload) => {
      signals.current += 1;
      setRequest((current) => nextShipApproval(current, shipPid, signal, payload));
    });
    const seen = signals.current;
    let live = true;
    // A signal that lands while history is in flight is newer than the snapshot.
    void getChatHistory(client, { pid: shipPid, includeMessages: false })
      .then((history) => { if (live && signals.current === seen) setRequest(history.pendingHil); })
      .catch(() => undefined);
    return () => { live = false; unsubscribe(); release(); };
  }, [client, connected, shipPid, observe]);

  const decide = useCallback(async (decision: ProcHilArgs["decision"], remember = false) => {
    if (!request || deciding) return;
    const args: ProcHilArgs = { pid: request.pid, requestId: request.requestId, decision };
    if (remember) args.remember = true;
    setDeciding(true);
    setError(null);
    try {
      await decideChatHil(client, args);
      setRequest((current) => current?.requestId === args.requestId ? null : current);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setDeciding(false);
    }
  }, [client, deciding, request]);

  return { request, deciding, error, decide };
}
