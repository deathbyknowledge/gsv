import type { ProcHilRequest } from "@humansandmachines/gsv/protocol";
import type { Ref } from "preact";
import { Hint } from "../../../components/ui/Tooltip";
import { hilAlwaysAllowSentence, hilDetailLabel, hilRequestLine, hilRequestSentence } from "../../../services/chat/domain/hil";
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
  onDecide: (decision: "approve" | "deny") => void;
  /** Save an account rule allowing this capability at this place, then run it. Absent when the viewer cannot edit that policy. */
  onAlwaysAllow?: () => void;
  alwaysAllowSaving?: boolean;
  alwaysAllowError?: string | null;
  /** Open the explanation of approvals and the per-kind choices beneath the card. */
  onExplain?: () => void;
};

/** Ship's pending approval: what it wants to do in the person's words, the raw request folded beneath. */
export function ApprovalCard({
  request, who, place, label, disabled = false, shortcuts = true, approveRef, onInspect, onDecide, onAlwaysAllow, alwaysAllowSaving, alwaysAllowError, onExplain,
}: ApprovalCardProps) {
  const line = hilRequestLine(request);
  const heading = <>{label ?? "approval"} · {place}</>;
  const exactDetails = <pre class="approval-exact">{JSON.stringify({ syscall: request.syscall, target: request.target, args: request.args }, null, 2)}</pre>;
  const held = disabled || alwaysAllowSaving === true;
  return (
    <div class="zen-approval">
      <div class="q">
        {onInspect ? <button type="button" onClick={onInspect} title="Inspect this approval in Fleet">{heading}</button> : heading}
      </div>
      <p class="ask">{hilRequestSentence(request, place)}</p>
      <details class="fold">
        <summary>{hilDetailLabel(request)}</summary>
        {line ? <>
          <div class="machine-rail">
            {line.lead === "prompt" ? commandLine(who, request.target, line.text) : <span class="cmd">
              {line.lead === "place" ? <><span class="where">{request.target}</span> · </> : null}
              {line.text}
            </span>}
          </div>
          <details class="fold">
            <summary>full request</summary>
            {exactDetails}
          </details>
        </> : exactDetails}
      </details>
      <div class="keys">
        <button ref={approveRef} type="button" class="ibtn is-primary" disabled={held} onClick={() => { if (!held) onDecide("approve"); }}>
          {shortcuts ? <kbd>y</kbd> : null} run it
        </button>
        <button type="button" class="ibtn" disabled={held} onClick={() => { if (!held) onDecide("deny"); }}>
          {shortcuts ? <kbd>n</kbd> : null} don't
        </button>
        {onAlwaysAllow ? (
          <Hint text={`Always ${hilAlwaysAllowSentence(request, place)} without asking. The rule is saved in Settings → permissions, where you can change it.`}>
            <button type="button" class="remember" disabled={held} onClick={() => { if (!held) onAlwaysAllow(); }}>
              {shortcuts ? <kbd>a</kbd> : null} always allow
            </button>
          </Hint>
        ) : null}
        <span>{alwaysAllowSaving ? "saving the rule…" : "nothing runs until you answer"}</span>
        {onExplain ? <button type="button" class="remember" onClick={onExplain}>why am I being asked?</button> : null}
      </div>
      {alwaysAllowError ? (
        <p class="consequence is-err" role="alert">{`the rule was not saved: ${alwaysAllowError}. You can still run it once.`}</p>
      ) : null}
    </div>
  );
}
