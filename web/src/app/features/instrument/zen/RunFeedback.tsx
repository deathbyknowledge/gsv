export function RunFeedback({ model, place, online, awaitingApproval }: {
  model: string | null;
  place: string;
  online: boolean;
  awaitingApproval: boolean;
}) {
  return <div class="zen-run-status" role="status" aria-atomic="false">
    {awaitingApproval && <span class="is-warn">waiting for your approval</span>}
    {model && <span>attempting {model}</span>}
    <span>{place} {online ? "ready" : "offline"}</span>
  </div>;
}
