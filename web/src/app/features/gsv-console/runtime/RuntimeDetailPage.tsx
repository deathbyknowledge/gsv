import { useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";
import { ConfirmModal } from "../../../components/ui/ConfirmModal";
import { dispatchTargetChatProcess } from "../../chat/domain/targetChatProcess";
import { ConsoleDetailPage } from "../components/ConsoleDetailPage";
import type { ConsoleProcess } from "../domain/consoleModels";
import { useRunConsoleProcessAction } from "../hooks/useConsoleData";
import {
  iconForProcess,
  processBlurb,
  processDetailSections,
  processNoun,
  statusForProcess,
  toneForProcess,
} from "./runtimePresentation";

type RuntimeDetailPageProps = {
  onBack: () => void;
  process: ConsoleProcess;
};

type TaskAction = "abort" | "reset" | "kill";

export function RuntimeDetailPage({ onBack, process }: RuntimeDetailPageProps) {
  const [confirmAction, setConfirmAction] = useState<TaskAction | null>(null);
  const action = useRunConsoleProcessAction();
  const pending = action.isPending;
  const canAbort = process.state === "running" || process.activeRunId !== null || process.queuedCount > 0;
  const runAction = (kind: TaskAction) => {
    action.mutate({
      pid: process.pid,
      action: kind,
      ...(kind === "abort" && process.activeRunId ? { runId: process.activeRunId } : {}),
    });
  };
  const openChat = () => {
    dispatchTargetChatProcess({ pid: process.pid });
  };
  const confirm = confirmAction ? taskActionConfirmation(confirmAction, process) : null;
  // Only an interactive process is a chat; everything else on this page is a
  // background process and says so. See processNoun.
  const noun = processNoun(process);
  const NOUN = noun.toUpperCase();

  return (
    <>
      <ConsoleDetailPage
        actions={(
          <div class="gsv-runtime-task-actions">
            <Button
              variant="secondary"
              label={pending && action.variables?.action === "abort" ? "ABORTING" : "ABORT RUN"}
              disabled={pending || !canAbort}
              onClick={() => setConfirmAction("abort")}
            />
            <Button
              variant="secondary"
              label={pending && action.variables?.action === "reset" ? "RESETTING" : `RESET ${NOUN}`}
              disabled={pending}
              onClick={() => setConfirmAction("reset")}
            />
            {action.isError ? <span class="gsv-runtime-task-action-error">{action.error.message}</span> : null}
          </div>
        )}
        dangerAction={(
          <Button
            variant="dangerGhost"
            label={pending && action.variables?.action === "kill" ? "KILLING" : `KILL ${NOUN}`}
            disabled={pending}
            onClick={() => setConfirmAction("kill")}
          />
        )}
        icon={iconForProcess(process)}
        title={process.label}
        typeLabel={`GSV · ${NOUN}`}
        statusLabel={statusForProcess(process)}
        tone={toneForProcess(process)}
        blurb={processBlurb(process)}
        parentLabel="CHATS"
        primaryLabel={`OPEN ${NOUN}`}
        onPrimary={openChat}
        sections={processDetailSections(process)}
        onBack={onBack}
      />
      {confirm ? (
        <div class="gsv-console-confirm-layer" onClick={() => setConfirmAction(null)}>
          <div class="gsv-console-confirm-wrap" onClick={(event) => event.stopPropagation()}>
            <ConfirmModal
              title={confirm.title}
              message={confirm.message}
              note={confirm.note}
              confirmLabel={confirm.confirmLabel}
              onCancel={() => setConfirmAction(null)}
              onConfirm={() => {
                runAction(confirm.action);
                setConfirmAction(null);
              }}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

function taskActionConfirmation(action: TaskAction, process: ConsoleProcess): {
  action: TaskAction;
  confirmLabel: string;
  message: string;
  note: string;
  title: string;
} {
  const noun = processNoun(process);
  const NOUN = noun.toUpperCase();
  if (action === "abort") {
    return {
      action,
      confirmLabel: "ABORT RUN",
      title: "CONFIRM ABORT",
      message: `Abort the active run for "${process.label}"?`,
      note: "The current run is interrupted. Queued work may continue after the abort.",
    };
  }
  if (action === "reset") {
    return {
      action,
      confirmLabel: `RESET ${NOUN}`,
      title: "CONFIRM RESET",
      message: `Reset ${noun} "${process.label}"?`,
      note: `The current history is archived and the ${noun} returns to a clean state.`,
    };
  }
  return {
    action,
    confirmLabel: `KILL ${NOUN}`,
    title: "CONFIRM KILL",
    message: `Kill ${noun} "${process.label}"?`,
    note: "The process is archived and removed from runtime.",
  };
}
