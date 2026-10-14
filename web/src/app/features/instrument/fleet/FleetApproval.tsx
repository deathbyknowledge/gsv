import { useMutation, useQueryClient } from "@tanstack/preact-query";
import type { ProcHilArgs } from "@humansandmachines/gsv/protocol";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useEffect, useRef } from "preact/hooks";
import { useViewActive } from "../../../services/navigation/ViewActivity";
import { LoadingState } from "../../../components/ui/Spinner";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { decideChatHil, getChatHistory } from "../../../services/chat/backend/chatService";
import { ApprovalCard } from "../shared/ApprovalCard";
import { INSTRUMENT_LEDGER_KEY, INSTRUMENT_PROCESSES_KEY } from "../wire/queryKeys";
import { referencedApproval } from "./fleetModel";

export function FleetApproval({ pid, who, label, requestId, runId, placeLabelFor = (target) => target, onInspect }: {
  pid: string;
  who: string;
  label?: string;
  requestId?: string;
  runId?: string;
  placeLabelFor?: (target: string) => string;
  onInspect?: () => void;
}) {
  const active = useViewActive();
  const { client, connected } = useGateway();
  const queryClient = useQueryClient();
  const queryKey = ["fleet", "pending-hil", pid, requestId ?? null, runId ?? null];
  const region = useRef<HTMLElement>(null);
  const approve = useRef<HTMLButtonElement>(null);
  const focused = useRef(false);
  const pending = useQuery({
    queryKey,
    queryFn: async () => (await getChatHistory(client, { pid, includeMessages: false })).pendingHil,
    enabled: connected,
    refetchOnMount: "always",
    refetchInterval: (query) => referencedApproval(query.state.data, pid, requestId) ? 2000 : false,
  });
  const pendingRequest = referencedApproval(pending.data, pid, requestId);
  const request = pendingRequest && (!runId || pendingRequest.runId === runId) ? pendingRequest : null;
  const decide = useMutation({
    mutationFn: (input: Omit<ProcHilArgs, "pid">) => decideChatHil(client, { pid, ...input }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["fleet", "pending-hil", pid] });
      void queryClient.invalidateQueries({ queryKey: INSTRUMENT_PROCESSES_KEY });
      void queryClient.invalidateQueries({ queryKey: INSTRUMENT_LEDGER_KEY });
    },
  });
  useEffect(() => {
    if (active && requestId && !focused.current && !pending.isPending && !pending.isFetching) {
      (request && !pending.isError ? approve.current : region.current)?.focus();
      focused.current = true;
    }
  }, [active, requestId, pending.isPending, pending.isFetching, pending.isError, request]);
  const decisionApplies = !request || decide.variables?.requestId === request.requestId;
  const ready = connected && !!request && !pending.isError && !pending.isFetching && !decide.isPending && !(decide.isSuccess && decisionApplies);

  return <section class="fleet-approval" ref={region} tabIndex={-1} aria-label="Approval request">
    {!connected ? <p class="note" role="status">Connecting…</p>
      : pending.isPending ? <p class="note"><LoadingState>Loading approval…</LoadingState></p>
      : pending.isError ? <p class="error" role="alert">Could not load this approval: {pending.error.message}</p>
      : !request ? <p class="note" role="status">{requestId ? "This approval is no longer pending." : "No approval is pending."}{pending.data && requestId ? " A different request is now waiting; open its approval from Chat." : ""}</p>
      : <ApprovalCard
        key={request.requestId}
        request={request}
        who={who}
        place={placeLabelFor(request.target)}
        label={label}
        disabled={!ready}
        shortcuts={false}
        approveRef={approve}
        onInspect={onInspect}
        onDecide={(decision, remember) => {
          if (!ready) return;
          const input: Omit<ProcHilArgs, "pid"> = { requestId: request.requestId, decision };
          if (remember) input.remember = true;
          decide.mutate(input);
        }}
      />}
    {decide.isSuccess && decisionApplies ? <p class="note" role="status">Decision recorded.</p> : null}
    {decide.error && decisionApplies ? <p class="error" role="alert">Could not record the decision: {decide.error.message}</p> : null}
  </section>;
}
