import { Hint } from "../../../components/ui/Tooltip";

export function RunFeedback({ model, places, awaitingApproval }: {
  model: string | null;
  places: readonly string[];
  awaitingApproval: boolean;
}) {
  const label = awaitingApproval ? "Waiting for your approval"
    : places.length > 0 ? `Working on ${places.join(", ")}…` : "Working…";
  return <div class="zen-run-status" role="status">
    {model ? <Hint text={`Model: ${model}`}>
      <span tabIndex={0} class={awaitingApproval ? "is-warn" : undefined}>{label}</span>
    </Hint> : <span class={awaitingApproval ? "is-warn" : undefined}>{label}</span>}
  </div>;
}
