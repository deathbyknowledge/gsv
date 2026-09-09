import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useEffect, useRef } from "preact/hooks";
import { LoadingState } from "../../../components/ui/Spinner";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { decideChatHil, getChatHistory } from "../../chat/backend/chatService";
import { INSTRUMENT_LEDGER_KEY, INSTRUMENT_PROCESSES_KEY } from "../wire/queryKeys";
import { referencedApproval } from "./fleetModel";

export function FleetApproval({ pid, requestId }: { pid: string; requestId?: string }) {
  const { client, connected } = useGateway();
  const queryClient = useQueryClient();
  const queryKey = ["fleet", "pending-hil", pid, requestId ?? null];
  const region = useRef<HTMLElement>(null);
  const approve = useRef<HTMLButtonElement>(null);
  const focused = useRef(false);
  const pending = useQuery({
    queryKey,
    queryFn: async () => (await getChatHistory(client, { pid, limit: 1, tail: true })).pendingHil,
    enabled: connected,
    refetchOnMount: "always",
    refetchInterval: (query) => referencedApproval(query.state.data, pid, requestId) ? 2000 : false,
  });
  const request = referencedApproval(pending.data, pid, requestId);
  const decide = useMutation({
    mutationFn: (input: { requestId: string; decision: "approve" | "deny" }) => decideChatHil(client, { pid, ...input }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["fleet", "pending-hil", pid] });
      void queryClient.invalidateQueries({ queryKey: INSTRUMENT_PROCESSES_KEY });
      void queryClient.invalidateQueries({ queryKey: INSTRUMENT_LEDGER_KEY });
    },
  });
  useEffect(() => {
    if (requestId && !focused.current && !pending.isPending && !pending.isFetching) {
      (request && !pending.isError ? approve.current : region.current)?.focus();
      focused.current = true;
    }
  }, [requestId, pending.isPending, pending.isFetching, pending.isError, request]);
  const decisionApplies = !request || decide.variables?.requestId === request.requestId;
  const ready = connected && !!request && !pending.isError && !pending.isFetching && !decide.isPending && !(decide.isSuccess && decisionApplies);

  return <section class="fleet-approval" ref={region} tabIndex={-1} aria-label="Approval request">
    <h4>Approval</h4>
    {requestId ? <div class="full-id">{requestId}</div> : null}
    {!connected ? <p class="note" role="status">Connecting…</p>
      : pending.isPending ? <p class="note"><LoadingState>Loading approval…</LoadingState></p>
      : pending.isError ? <p class="error" role="alert">Could not load this approval: {pending.error.message}</p>
      : !request ? <p class="note" role="status">{requestId ? "This approval is no longer pending." : "No approval is pending."}{pending.data && requestId ? " A different request is now waiting; open its approval from Zen." : ""}</p>
      : <>
        <p class="note">The process is held on <strong>{request.syscall}</strong> on <strong>{request.target}</strong>. Approving runs exactly what it asked for, nothing else.</p>
        <pre class="line-detail">{JSON.stringify(request.args, null, 2)}</pre>
        <div class="fleet-actions">
          <button ref={approve} type="button" class="ibtn is-primary" disabled={!ready} onClick={() => { if (ready) decide.mutate({ requestId: request.requestId, decision: "approve" }); }}>approve</button>
          <button type="button" class="ibtn is-danger" disabled={!ready} onClick={() => { if (ready) decide.mutate({ requestId: request.requestId, decision: "deny" }); }}>deny</button>
        </div>
      </>}
    {decide.isSuccess && decisionApplies ? <p class="note" role="status">Decision recorded.</p> : null}
    {decide.error && decisionApplies ? <p class="error" role="alert">Could not record the decision: {decide.error.message}</p> : null}
  </section>;
}
