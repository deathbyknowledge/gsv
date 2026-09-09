import { useQueryClient } from "@tanstack/preact-query";
import { useEffect, useRef } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleProcess, ConsoleTarget } from "../../gsv-console/domain/consoleModels";
import { consoleMcpServersQueryKey } from "../../gsv-console/hooks/useConsoleData";
import { instrumentProcessAiKey, INSTRUMENT_CONTACTS_KEY, INSTRUMENT_CONTACT_INVITES_KEY, INSTRUMENT_PROCESSES_KEY, INSTRUMENT_TARGETS_KEY } from "./queryKeys";
import { refreshContactQuery } from "./contactSync";
import { createLedgerSync } from "./ledgerSync";
import {
  isProcessSignal,
  ledgerChangedSignalSchema,
  patchProcesses,
  patchTargets,
  procSignalSchema,
  targetStatusSignalSchema,
} from "./wireModel";

/**
 * The one subscriber to the wire for the instrument's caches. Each signal is
 * a patch on the entry it names: a target's status, a process's run state,
 * lines appended to the ledger. A signal about something the cache has not
 * seen fetches that one list again; nothing refetches on a signal otherwise.
 * A reconnect after a drop is the only moment everything is fetched again.
 * Payload-free contact notifications use selective list invalidation below.
 */
export function WireSync(): null {
  const { client, connected } = useGateway();
  const queryClient = useQueryClient();
  const dropped = useRef(false);
  const connectedBefore = useRef(connected);

  useEffect(() => {
    if (!connected) {
      if (connectedBefore.current) dropped.current = true;
      return;
    }
    connectedBefore.current = true;
    if (dropped.current) {
      dropped.current = false;
      void queryClient.invalidateQueries();
    }
  }, [connected, queryClient]);

  useEffect(() => {
    if (!connected) return;
    const ledger = createLedgerSync(queryClient);
    const unsubscribe = client.onSignal((signal, payload) => {
      // Contacts carry invalidations, so invitation codes and private records stay out of signals.
      if (signal === "contact.changed" || signal === "contact.invite.changed") {
        void refreshContactQuery(queryClient, signal === "contact.changed" ? INSTRUMENT_CONTACTS_KEY : INSTRUMENT_CONTACT_INVITES_KEY);
        return;
      }
      if (signal === "mcp.changed") {
        void queryClient.invalidateQueries({ queryKey: consoleMcpServersQueryKey });
        return;
      }
      if (signal === "target.status") {
        const parsed = targetStatusSignalSchema.safeParse(payload);
        if (!parsed.success) return;
        const current = queryClient.getQueryData<ConsoleTarget[]>(INSTRUMENT_TARGETS_KEY);
        if (!current) return;
        const patch = patchTargets(current, parsed.data, Date.now());
        if (patch.known) queryClient.setQueryData(INSTRUMENT_TARGETS_KEY, patch.next);
        else void queryClient.invalidateQueries({ queryKey: INSTRUMENT_TARGETS_KEY });
        return;
      }
      if (isProcessSignal(signal)) {
        const parsed = procSignalSchema.safeParse(payload);
        if (!parsed.success) return;
        if (signal === "proc.changed" && parsed.data.changes?.includes("ai.config")) {
          const key = instrumentProcessAiKey(parsed.data.pid);
          if (queryClient.getQueryState(key)) {
            // Ambient signals omit raw process details; refresh only this process's preferences.
            if (parsed.data.aiConfig === undefined) void queryClient.invalidateQueries({ queryKey: key });
            else queryClient.setQueryData(key, parsed.data.aiConfig);
          }
        }
        const current = queryClient.getQueryData<ConsoleProcess[]>(INSTRUMENT_PROCESSES_KEY);
        if (!current) return;
        const patch = patchProcesses(current, signal, parsed.data, Date.now());
        if (patch.known) queryClient.setQueryData(INSTRUMENT_PROCESSES_KEY, patch.next);
        else void queryClient.invalidateQueries({ queryKey: INSTRUMENT_PROCESSES_KEY });
        return;
      }
      if (signal === "ledger.changed") {
        const parsed = ledgerChangedSignalSchema.safeParse(payload);
        if (!parsed.success) return;
        ledger.changed(parsed.data.lines);
      }
    });
    return () => { unsubscribe(); ledger.stop(); };
  }, [client, connected, queryClient]);

  return null;
}
