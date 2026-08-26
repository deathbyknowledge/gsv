import { SectionHeader } from "../../../components/ui/SectionHeader";
import { ChatApprovalBanner } from "../../chat/components/ChatApprovalBanner";
import { useChatRuntime } from "../../chat/hooks/useChatRuntime";
import {
  useChatProcessTrace,
  useDecideChatHil,
} from "../../chat/hooks/useChatProcesses";
import type { ConsoleProcess } from "../domain/consoleModels";
import "./RuntimeActivity.css";
import { RuntimeFlameChart } from "./RuntimeFlameChart";

type RuntimeActivityProps = {
  process: ConsoleProcess;
};

function historyError(value: Error | null): string {
  return value?.message.trim()
    ? value.message
    : "Process activity could not be loaded.";
}

export function RuntimeActivity({ process }: RuntimeActivityProps) {
  const activity = useChatRuntime({
    historyLimit: 500,
    processId: process.pid,
    observe: true,
  });
  const trace = useChatProcessTrace({
    args: { pid: process.pid, limit: 1_000 },
  });
  const decision = useDecideChatHil();
  const pendingHil = activity.runtime.pendingHil;
  const applyDecision = (next: "approve" | "deny", remember = false) => {
    if (!pendingHil || decision.isPending) return;
    decision.mutate({
      pid: process.pid,
      requestId: pendingHil.requestId,
      decision: next,
      ...(remember ? { remember: true } : undefined),
    });
  };

  return (
    <section class="gsv-runtime-activity" aria-label={`${process.label} process activity`}>
      <SectionHeader
        title="PROCESS ACTIVITY"
        meta={process.activeRunId ? "LIVE" : `${trace.data?.spanCount ?? 0} SPANS`}
        divider
      />
      <div class="gsv-runtime-activity-body">
        {trace.isLoading || activity.history.isLoading ? (
          <div class="gsv-runtime-trace-empty"><strong>LOADING TRACE</strong></div>
        ) : trace.isError || activity.history.isError ? (
          <div class="gsv-runtime-trace-empty is-error">
            <strong>TRACE UNAVAILABLE</strong>
            <span>{historyError(trace.error ?? activity.history.error)}</span>
          </div>
        ) : trace.data ? (
          <RuntimeFlameChart
            rows={activity.runtime.rows}
            trace={trace.data}
          />
        ) : null}
      </div>
      {pendingHil ? (
        <ChatApprovalBanner
          busy={decision.isPending}
          pendingHil={pendingHil}
          onDecision={applyDecision}
        />
      ) : null}
      {decision.isError ? (
        <p class="gsv-runtime-activity-error gsv-prose">{decision.error.message}</p>
      ) : null}
    </section>
  );
}
