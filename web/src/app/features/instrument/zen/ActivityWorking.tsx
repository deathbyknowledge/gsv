import type { Activity } from "./zenModel";

export function ActivityWorking({ activity }: { activity: Activity }) {
  return (
    <div class="work-calls">
      {activity.calls.map((call) => {
        const shell = call.syscall === "shell.exec";
        const code = call.syscall === "codemode.exec" || call.syscall === "codemode.run" || call.syscall === "CodeMode";
        const subject = call.operation?.subject ?? (call.summary === call.syscall ? "" : call.summary);
        const state = call.failed ? "failed" : !call.finished && !call.operation ? "running…" : "";
        return (
          <div key={call.callId} class={`work-call${shell ? " work-shell" : code ? " work-code" : " work-operation"}${call.failed ? " is-failed" : ""}`}>
            {shell ? (
              <pre class="work-command"><span class="shell-prompt">$</span> {call.summary}</pre>
            ) : (
              <div class="work-heading">
                <span>{code ? "CodeMode" : call.operation?.label ?? call.syscall}</span>
                {!code && subject ? <> <code class="work-subject">{subject}</code></> : null}
                {call.operation?.detail ? <span class="work-detail"> · {call.operation.detail}</span> : null}
                {state ? <span class="work-state"> · {state}</span> : null}
              </div>
            )}
            {code && call.summary ? <pre class="work-source"><code>{call.summary}</code></pre> : null}
            {call.output ? <>
              {code ? <div class="work-output-label">output</div> : null}
              <pre class="work-output">{call.output}</pre>
            </> : null}
            {shell && state ? <div class="work-state">{state}</div> : null}
          </div>
        );
      })}
    </div>
  );
}
