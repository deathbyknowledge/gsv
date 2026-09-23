import { Hint } from "../../../components/ui/Tooltip";
import { Spinner } from "../../../components/ui/Spinner";
import { useViewActive } from "../../../services/navigation/ViewActivity";

export function RunFeedback({ model, places, awaitingApproval, running }: {
  model: string | null;
  places: readonly string[];
  awaitingApproval: boolean;
  running: boolean;
}) {
  const visible = useViewActive();
  const label = awaitingApproval ? "Waiting for your approval"
    : !running ? "Idle" : places.length > 0 ? `Working on ${places.join(", ")}` : "Working";
  return <Hint text={model && running ? `${label} · Model: ${model}` : label}>
    <span class="zen-run-indicator" role="status" aria-label={label} tabIndex={0}>
      <Spinner size={28} variant="ring" animate={visible && running && !awaitingApproval} />
    </span>
  </Hint>;
}
