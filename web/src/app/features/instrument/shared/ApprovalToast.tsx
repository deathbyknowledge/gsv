import { useCallback } from "preact/hooks";
import { useQuery, useQueryClient } from "@tanstack/preact-query";
import { findConsolePersonalProcess } from "../../../domain/system/consoleProcesses";
import { useT } from "../../../i18n/locale";
import { getProcessHistorySync } from "../../../services/chat/backend/historySync";
import { canAlwaysAllow, hilRequestLine, hilRequestSentence } from "../../../services/chat/domain/hil";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { loadConsoleProcesses, loadConsoleTargets } from "../../../services/system/consoleService";
import { INSTRUMENT_LEDGER_KEY, INSTRUMENT_PROCESSES_KEY, INSTRUMENT_TARGETS_KEY } from "../wire/queryKeys";
import { placeLabel } from "../zen/zenModel";
import { useShipApproval, type ShipApproval } from "./useShipApproval";
import "./approvalToast.css";

/**
 * The Ship's pending approval while Chat is not showing it: a corner toast beside
 * handsfree's that answers through the same request as Chat's card. It announces
 * itself but never takes focus; Chat keeps the full card.
 */
export function ApprovalToast({ approval, hidden, place = (target) => placeLabel(target, []), onOpenChat }: {
  approval: ShipApproval;
  hidden: boolean;
  place?: (target: string) => string;
  onOpenChat: () => void;
}) {
  const t = useT();
  const { request, deciding, error, decide } = approval;
  if (hidden || !request) return null;
  const line = hilRequestLine(request);
  return <aside class="approval-toast" aria-label={t("shell.approval.toastLabel")} data-instrument-dialog onKeyDown={(event) => event.stopPropagation()}>
    <header><span>{t("shell.approval.label")} <span class="approval-toast-title" role="status">{t("shell.approval.toastTitle")}</span></span></header>
    <p class="approval-toast-sentence">{hilRequestSentence(request, place(request.target))}</p>
    {line?.lead === "prompt" && <code class="approval-toast-line">$ {line.text}</code>}
    <div class="approval-toast-actions">
      <button type="button" class="primary" disabled={deciding} onClick={() => decide("approve")}>{t("shell.approval.run")}</button>
      {canAlwaysAllow(request) && <button type="button" disabled={deciding} title={t("shell.approval.alwaysAllowHint", { place: place(request.target) })} onClick={() => decide("approve", true)}>{t("shell.approval.alwaysAllow")}</button>}
      <button type="button" disabled={deciding} onClick={() => decide("deny")}>{t("shell.approval.deny")}</button>
      <button type="button" class="approval-toast-open" onClick={onOpenChat}>{t("shell.approval.openChat")}</button>
    </div>
    {error && <p class="approval-toast-error" role="alert">{error}</p>}
  </aside>;
}

/** The app-wide prompt: follows the current Ship pid and shares Chat's history sync and place names. */
export function ShipApprovalPrompt({ hidden, onOpenChat }: { hidden: boolean; onOpenChat: () => void }) {
  const { client, connected } = useGateway();
  const queries = useQueryClient();
  const processes = useQuery({ queryKey: INSTRUMENT_PROCESSES_KEY, queryFn: () => loadConsoleProcesses(client), enabled: connected });
  const targets = useQuery({ queryKey: INSTRUMENT_TARGETS_KEY, queryFn: () => loadConsoleTargets(client), enabled: connected });
  const shipPid = findConsolePersonalProcess(processes.data ?? [])?.pid ?? null;
  const observe = useCallback((pid: string) => getProcessHistorySync(client, queries).watch(pid), [client, queries]);
  const approval = useShipApproval({ client, connected, shipPid, observe });
  const places = (targets.data ?? []).map((target) => ({ id: target.deviceId, label: target.label || target.deviceId, online: target.online }));
  const decide: ShipApproval["decide"] = async (decision, remember) => {
    await approval.decide(decision, remember);
    void queries.invalidateQueries({ queryKey: INSTRUMENT_PROCESSES_KEY });
    void queries.invalidateQueries({ queryKey: INSTRUMENT_LEDGER_KEY });
  };
  return <ApprovalToast approval={{ ...approval, decide }} hidden={hidden} place={(target) => placeLabel(target, places)} onOpenChat={onOpenChat} />;
}
