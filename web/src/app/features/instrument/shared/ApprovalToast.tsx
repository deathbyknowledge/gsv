import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/preact-query";
import type { ProcHilArgs, ProcHilRequest } from "@humansandmachines/gsv/protocol";
import type { ConsoleProcess } from "../../../domain/system/consoleModels";
import { useT } from "../../../i18n/locale";
import { decideChatHil, getChatHistory } from "../../../services/chat/backend/chatService";
import { canAlwaysAllow, hilRequestLine, hilRequestSentence } from "../../../services/chat/domain/hil";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { loadConsoleProcesses, loadConsoleTargets } from "../../../services/system/consoleService";
import { INSTRUMENT_LEDGER_KEY, INSTRUMENT_PROCESSES_KEY, INSTRUMENT_TARGETS_KEY } from "../wire/queryKeys";
import { placeLabel } from "../zen/zenModel";
import { useVisibleApprovals } from "./visibleApprovals";
import "./approvalToast.css";

export type PendingApproval = { process: ConsoleProcess; request: ProcHilRequest };
type Decision = { approval: PendingApproval; decision: ProcHilArgs["decision"]; remember: boolean };

const PENDING_KEY = ["approvals", "pending"] as const;

/**
 * Every approval waiting for this person, from any of their processes, in a corner
 * card beside handsfree's. The process registry, which WireSync keeps current from
 * the wire, says who is waiting; each one's history supplies the exact request, so a
 * request answered anywhere, or a run that ends, leaves as soon as the registry moves.
 * Only the owning human may decide a request, so other people's never show, even to root.
 * A request whose own card is on screen stays with that card. The newest shows, with
 * a count of the rest; it announces itself through a live region and never takes focus.
 */
export function ApprovalPrompt({ viewerUid, onOpen }: { viewerUid: number | null; onOpen: (approval: PendingApproval) => void }) {
  const t = useT();
  const { client, connected } = useGateway();
  const queries = useQueryClient();
  const processes = useQuery({ queryKey: INSTRUMENT_PROCESSES_KEY, queryFn: () => loadConsoleProcesses(client), enabled: connected });
  const targets = useQuery({ queryKey: INSTRUMENT_TARGETS_KEY, queryFn: () => loadConsoleTargets(client), enabled: connected });
  const waiting = (processes.data ?? []).filter((process) => process.uid === viewerUid && process.state === "waiting_hil" && process.activeRunId);
  const requests = useQueries({
    queries: waiting.map((process) => ({
      queryKey: [...PENDING_KEY, process.pid, process.activeRunId],
      queryFn: async () => (await getChatHistory(client, { pid: process.pid, includeMessages: false })).pendingHil,
      enabled: connected,
    })),
  });
  const visible = useVisibleApprovals();
  const decide = useMutation({
    mutationFn: ({ approval: { request }, decision, remember }: Decision) => {
      const args: ProcHilArgs = { pid: request.pid, requestId: request.requestId, decision };
      if (remember) args.remember = true;
      return decideChatHil(client, args);
    },
    onSettled: () => {
      void queries.invalidateQueries({ queryKey: PENDING_KEY });
      void queries.invalidateQueries({ queryKey: INSTRUMENT_PROCESSES_KEY });
      void queries.invalidateQueries({ queryKey: INSTRUMENT_LEDGER_KEY });
    },
  });
  const decided = decide.isSuccess ? decide.variables.approval.request.requestId : null;
  const approvals = waiting.flatMap((process, index): PendingApproval[] => {
    const request = requests[index]?.data;
    return request && request.pid === process.pid && request.runId === process.activeRunId
      && request.requestId !== decided && !visible.has(request.requestId) ? [{ process, request }] : [];
  }).sort((a, b) => b.request.createdAt - a.request.createdAt);

  const shown = approvals[0];
  const title = !shown ? "" : shown.process.personal ? t("shell.approval.shipWaiting")
    : t("shell.approval.workWaiting", { work: capitalized(shown.process.label || shown.process.pid) });
  const places = (targets.data ?? []).map((target) => ({ id: target.deviceId, label: target.label || target.deviceId, online: target.online }));
  const place = shown ? placeLabel(shown.request.target, places) : "";
  const line = shown ? hilRequestLine(shown.request) : null;
  const deciding = decide.isPending || !connected;
  const answer = (decision: ProcHilArgs["decision"], remember = false) => {
    if (shown && !deciding) decide.mutate({ approval: shown, decision, remember });
  };
  const failed = decide.error && decide.variables?.approval.request.requestId === shown?.request.requestId ? decide.error.message : null;

  return <>
    <p class="approval-toast-live" role="status">{title}</p>
    {shown && <aside class="approval-toast" aria-label={t("shell.approval.toastLabel")} data-instrument-dialog onKeyDown={(event) => event.stopPropagation()}>
      <header>
        <span class="approval-toast-title">{title}</span>
        {approvals.length > 1 && <span class="approval-toast-more">{t("shell.approval.more", { count: approvals.length - 1 })}</span>}
      </header>
      <p class="approval-toast-sentence">{hilRequestSentence(shown.request, place)}</p>
      {line?.lead === "prompt" && <code class="approval-toast-line">$ {line.text}</code>}
      <div class="approval-toast-actions">
        <button type="button" class="primary" disabled={deciding} onClick={() => answer("approve")}>{t("shell.approval.run")}</button>
        {canAlwaysAllow(shown.request) && <button type="button" disabled={deciding} title={t("shell.approval.alwaysAllowHint", { place })} onClick={() => answer("approve", true)}>{t("shell.approval.alwaysAllow")}</button>}
        <button type="button" disabled={deciding} onClick={() => answer("deny")}>{t("shell.approval.deny")}</button>
        <button type="button" class="approval-toast-open" onClick={() => onOpen(shown)}>{t("shell.approval.open")}</button>
      </div>
      {failed && <p class="approval-toast-error" role="alert">{failed}</p>}
    </aside>}
  </>;
}

/** A task title as a heading: its first letter upper-cased, the rest as written. */
function capitalized(title: string): string {
  const first = Array.from(title)[0] ?? "";
  return `${first.toLocaleUpperCase()}${title.slice(first.length)}`;
}
