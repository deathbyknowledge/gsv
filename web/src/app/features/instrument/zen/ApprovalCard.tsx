import type { ProcHilRequest } from "@humansandmachines/gsv/protocol";
import { hilDetailLabel, hilRequestDetail, hilRequestSentence } from "../../../services/chat/domain/hil";

export type ApprovalCardProps = {
  request: ProcHilRequest;
  /** The account the action would run as, shown in the folded request line. */
  who: string;
  /** The place's label, as the person knows it. */
  place: string;
  onInspect: () => void;
  onDecide: (decision: "approve" | "deny") => void;
};

/** Ship's pending approval: what it wants to do in the person's words, the raw request folded beneath. */
export function ApprovalCard({ request, who, place, onInspect, onDecide }: ApprovalCardProps) {
  const detail = hilRequestDetail(request);
  return (
    <div class="zen-approval">
      <div class="q">
        <button type="button" onClick={onInspect} title="Inspect this approval in Fleet">approval · {place}</button>
      </div>
      <p class="ask">{hilRequestSentence(request, place)}</p>
      {detail ? (
        <details class="fold">
          <summary>{hilDetailLabel(request)}</summary>
          <div class="machine-rail">
            <span class="cmd">
              <span class="who">{who}</span>@<span class="where">{request.target}</span> $ {request.syscall}{" "}
              {detail}
            </span>
          </div>
        </details>
      ) : null}
      <div class="keys">
        <button type="button" class="ibtn is-primary" onClick={() => onDecide("approve")}>
          <kbd>y</kbd> run it
        </button>
        <button type="button" class="ibtn" onClick={() => onDecide("deny")}>
          <kbd>n</kbd> don't
        </button>
        <span>nothing runs until you answer</span>
      </div>
    </div>
  );
}
