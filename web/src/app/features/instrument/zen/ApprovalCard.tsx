import type { ProcHilRequest } from "@humansandmachines/gsv/protocol";
import { hilAlwaysAllowSentence, hilDetailLabel, hilRequestLine, hilRequestSentence } from "../../../services/chat/domain/hil";
import { commandLine } from "./commandLine";

export type ApprovalCardProps = {
  request: ProcHilRequest;
  /** The account the action would run as, shown in the folded request line. */
  who: string;
  /** The place's label, as the person knows it. */
  place: string;
  onInspect: () => void;
  onDecide: (decision: "approve" | "deny") => void;
  /** Record an allow rule for this capability and place, then run it. Absent when the account cannot edit its policy. */
  onAlwaysAllow?: () => void;
  alwaysAllowSaving?: boolean;
  alwaysAllowError?: string | null;
};

/** Ship's pending approval: what it wants to do in the person's words, the raw request folded beneath. */
export function ApprovalCard({ request, who, place, onInspect, onDecide, onAlwaysAllow, alwaysAllowSaving, alwaysAllowError }: ApprovalCardProps) {
  const line = hilRequestLine(request);
  const busy = alwaysAllowSaving === true;
  return (
    <div class="zen-approval">
      <div class="q">
        <button type="button" onClick={onInspect} title="Inspect this approval in Fleet">approval · {place}</button>
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
        <button type="button" class="ibtn is-primary" disabled={busy} onClick={() => onDecide("approve")}>
          <kbd>y</kbd> run it
        </button>
        <button type="button" class="ibtn" disabled={busy} onClick={() => onDecide("deny")}>
          <kbd>n</kbd> don't
        </button>
        {onAlwaysAllow ? (
          <button type="button" class="ibtn" disabled={busy} onClick={onAlwaysAllow}>
            <kbd>a</kbd> always allow this
          </button>
        ) : null}
        <span>{busy ? "saving the rule…" : "nothing runs until you answer"}</span>
      </div>
      {onAlwaysAllow ? (
        <p class="consequence">{`always: ${hilAlwaysAllowSentence(request, place)}, without asking`}</p>
      ) : null}
      {alwaysAllowError ? (
        <p class="consequence is-err" role="alert">{`the rule was not saved: ${alwaysAllowError}. You can still run it once.`}</p>
      ) : null}
    </div>
  );
}
