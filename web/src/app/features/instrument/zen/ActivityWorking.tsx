import { UNKNOWN_TARGET, type Activity, type ActivityCall } from "./zenModel";
import { commandLine } from "../shared/commandLine";
import { Spinner } from "../../../components/ui/Spinner";
import { useT, type TextKey } from "../../../i18n/locale";

export function ActivityWorking({ activity, who }: { activity: Activity; who: string }) {
  return (
    <div class="work-calls">
      {activity.calls.map((call) => {
        const loading = activity.terminal
          ? activity.terminal.status === "starting" || activity.terminal.status === "running"
          : !call.finished && !call.failed && !call.operation;
        const state: TextKey | undefined = activity.terminal ? activity.terminal.action === "stop" ? "chat.work.stopping"
          : activity.terminal.status === "unavailable" ? "chat.work.unavailable"
          : loading || activity.terminal.status === "completed" ? undefined
          : activity.terminal.status === "stopped" ? "chat.work.stopped" : "chat.work.failed"
          : call.failed ? "chat.work.failed" : undefined;
        return <CallWorking key={call.callId} call={call} who={who} target={activity.target} state={state} loading={loading} />;
      })}
    </div>
  );
}

export function CallWorking({ call, who, target, state, loading = false }: {
  call: ActivityCall;
  who: string;
  target: string | null;
  state?: TextKey;
  loading?: boolean;
}) {
  const t = useT();
  const shell = call.syscall === "shell.exec";
  const code = call.syscall === "codemode.exec" || call.syscall === "codemode.run" || call.syscall === "CodeMode";
  const subject = call.operation?.subject ?? (call.summary === call.syscall ? "" : call.summary);
  const stateText = state ? t(state) : "";
  const progress = loading ? <span class="work-pending" role="status" aria-label={stateText || t("chat.work.runningCommand")}><Spinner size={16} /></span> : null;
  return (
    <div class={`work-call machine-rail${shell ? " work-shell" : code ? " work-code" : " work-operation"}${call.failed ? " is-failed" : ""}`}>
      {shell ? (
        <pre class="work-command">{commandLine(who, target === UNKNOWN_TARGET ? t("chat.place.unknown") : target, call.summary)}</pre>
      ) : (
        <div class="work-heading">
          <span>{code ? "CodeMode" : call.operation?.label ?? call.syscall.split(".").at(-1)}</span>
          {!code && subject ? <> <code class="work-subject">{subject}</code></> : null}
          {call.operation?.detail ? <span class="work-detail"> · {call.operation.detail}</span> : null}
          {stateText ? <span class="work-state"> · {stateText}</span> : null}
          {progress}
        </div>
      )}
      {code && call.summary ? <pre class="work-source"><code>{call.summary}</code></pre> : null}
      {call.details?.map((detail) => <div key={detail.label} class="work-input">
        <div class="work-output-label">{detail.label}</div>
        <pre class="work-source">{detail.text || t("chat.work.empty")}</pre>
      </div>)}
      {call.output ? <>
        {code ? <div class="work-output-label">{t("chat.work.output")}</div> : null}
        <pre class="work-output">{call.output}</pre>
      </> : null}
      {shell && (stateText || loading) ? <div class="work-state">{progress}{stateText}</div> : null}
    </div>
  );
}
