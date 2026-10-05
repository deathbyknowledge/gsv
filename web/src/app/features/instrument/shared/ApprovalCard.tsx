import type { ProcHilRequest } from "@humansandmachines/gsv/protocol";
import type { Ref } from "preact";
import { Hint } from "../../../components/ui/Tooltip";
import { hilDetailLabel, hilRequestLine, hilRequestSentence } from "../../../services/chat/domain/hil";
import { commandLine } from "./commandLine";
import "./approvalCard.css";

export type ApprovalCardProps = {
  request: ProcHilRequest;
  /** The account the action would run as, shown in the folded request line. */
  who: string;
  /** The place's label, as the person knows it. */
  place: string;
  label?: string;
  disabled?: boolean;
  shortcuts?: boolean;
  approveRef?: Ref<HTMLButtonElement>;
  onInspect?: () => void;
  onDecide: (decision: "approve" | "deny", remember?: boolean) => void;
};

/** Ship's pending approval: what it wants to do in the person's words, the raw request folded beneath. */
export function ApprovalCard({ request, who, place, label, disabled = false, shortcuts = true, approveRef, onInspect, onDecide }: ApprovalCardProps) {
  const line = hilRequestLine(request);
  const heading = <>{label ?? "approval"} · {place}</>;
  return (
    <div class="zen-approval">
      <div class="q">
        {onInspect ? <button type="button" onClick={onInspect} title="Inspect this approval in Fleet">{heading}</button> : heading}
      </div>
      <p class="ask">{hilRequestSentence(request, place)}</p>
      {line ? (
        <details class="fold">
          <summary>{hilDetailLabel(request)}</summary>
          <div class="machine-rail">
            {line.lead === "prompt" ? commandLine(who, request.target, line.text) : <span class="cmd">
              {line.lead === "place" ? <><span class="where">{request.target}</span> · </> : null}
              {line.text}
            </span>}
          </div>
        </details>
      ) : null}
      <div class="keys">
        <button ref={approveRef} type="button" class="ibtn is-primary" disabled={disabled} onClick={() => { if (!disabled) onDecide("approve"); }}>
          {shortcuts ? <kbd>y</kbd> : null} run it
        </button>
        <button type="button" class="ibtn" disabled={disabled} onClick={() => { if (!disabled) onDecide("deny"); }}>
          {shortcuts ? <kbd>n</kbd> : null} don't
        </button>
        {request.syscall === "shell.exec" && !["*", "any", "device", "devices/*", "targets/*"].includes(request.target) ? (
          <Hint text={`Allow this process to run any shell command on ${place} without asking again. Other processes still ask.`}>
            <button type="button" class="remember" disabled={disabled} onClick={() => { if (!disabled) onDecide("approve", true); }}>always allow</button>
          </Hint>
        ) : null}
        <span>nothing runs until you answer</span>
      </div>
    </div>
  );
}
