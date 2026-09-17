import type { Activity, ActivityCall } from "./zenModel";
import { commandLine } from "./commandLine";

export function ActivityWorking({ activity, who }: { activity: Activity; who: string }) {
  return (
    <div class="work-calls">
      {activity.calls.map((call) => {
        const state = activity.terminal ? activity.terminal.action === "stop" ? "stopping…"
          : activity.terminal.status === "unavailable" ? "status unavailable"
          : activity.terminal.status === "completed" ? "" : activity.terminal.status
          : call.failed ? "failed" : !call.finished && !call.operation ? "running…" : "";
        return <CallWorking key={call.callId} call={call} who={who} target={activity.target} state={state} />;
      })}
    </div>
  );
}

export function CallWorking({ call, who, target, state = "" }: {
  call: ActivityCall;
  who: string;
  target: string | null;
  state?: string;
}) {
  const shell = call.syscall === "shell.exec";
  const code = call.syscall === "codemode.exec" || call.syscall === "codemode.run" || call.syscall === "CodeMode";
  const subject = call.operation?.subject ?? (call.summary === call.syscall ? "" : call.summary);
  return (
    <div class={`work-call machine-rail${shell ? " work-shell" : code ? " work-code" : " work-operation"}${call.failed ? " is-failed" : ""}`}>
      {shell ? (
        <pre class="work-command">{commandLine(who, target, call.summary)}</pre>
      ) : (
        <div class="work-heading">
          <span>{code ? "CodeMode" : call.operation?.label ?? call.syscall.split(".").at(-1)}</span>
          {!code && subject ? <> <code class="work-subject">{subject}</code></> : null}
          {call.operation?.detail ? <span class="work-detail"> · {call.operation.detail}</span> : null}
          {state ? <span class="work-state"> · {state}</span> : null}
        </div>
      )}
      {code && call.summary ? <pre class="work-source"><code>{call.summary}</code></pre> : null}
      {call.details?.map((detail) => <div key={detail.label} class="work-input">
        <div class="work-output-label">{detail.label}</div>
        <pre class="work-source">{detail.text || "(empty)"}</pre>
      </div>)}
      {call.output ? <>
        {code ? <div class="work-output-label">output</div> : null}
        <pre class="work-output">{call.output}</pre>
      </> : null}
      {shell && state ? <div class="work-state">{state}</div> : null}
    </div>
  );
}
