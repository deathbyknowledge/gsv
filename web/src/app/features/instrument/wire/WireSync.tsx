import { useQueryClient } from "@tanstack/preact-query";
import { useEffect, useRef } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleProcess, ConsoleTarget } from "../../gsv-console/domain/consoleModels";
import { ledgerFromSysLines, sysLedgerListResultSchema } from "../fleet/fleetModel";
import { instrumentProcessAiKey, INSTRUMENT_LEDGER_KEY, INSTRUMENT_LEDGER_PAGE, INSTRUMENT_PROCESSES_KEY, INSTRUMENT_TARGETS_KEY } from "./queryKeys";
import {
  isProcessSignal,
  ledgerAppendedSignalSchema,
  patchProcesses,
  patchTargets,
  prependLedger,
  procSignalSchema,
  targetStatusSignalSchema,
  type LedgerPages,
} from "./wireModel";

const LEDGER_SYS_KEY = [...INSTRUMENT_LEDGER_KEY, "sys"] as const;

/**
 * The one subscriber to the wire for the instrument's caches. Each signal is
 * a patch on the entry it names: a target's status, a process's run state,
 * lines appended to the ledger. A signal about something the cache has not
 * seen fetches that one list again; nothing refetches on a signal otherwise.
 * A reconnect after a drop is the only moment everything is fetched again.
 */
export function WireSync(): null {
  const { client, connected } = useGateway();
  const queryClient = useQueryClient();
  const dropped = useRef(false);

  useEffect(() => {
    if (!connected) {
      dropped.current = true;
      return;
    }
    if (dropped.current) {
      dropped.current = false;
      void queryClient.invalidateQueries();
    }
  }, [connected, queryClient]);

  useEffect(() => {
    return client.onSignal((signal, payload) => {
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
      if (signal === "ledger.appended") {
        const parsed = ledgerAppendedSignalSchema.safeParse(payload);
        if (!parsed.success) return;
        if (!queryClient.getQueryData<LedgerPages>(LEDGER_SYS_KEY)) return;
        if (parsed.data.count > INSTRUMENT_LEDGER_PAGE) {
          // more arrived at once than one page holds: walk the loaded pages again rather than leave a gap
          void queryClient.invalidateQueries({ queryKey: INSTRUMENT_LEDGER_KEY });
          return;
        }
        void client
          .call("sys.ledger.list", { limit: parsed.data.count })
          .then((raw) => {
            const fresh = ledgerFromSysLines(sysLedgerListResultSchema.parse(raw).lines);
            queryClient.setQueryData<LedgerPages>(LEDGER_SYS_KEY, (data) => (data ? prependLedger(data, fresh) : data));
          })
          .catch(() => undefined);
      }
    });
  }, [client, queryClient]);

  return null;
}
