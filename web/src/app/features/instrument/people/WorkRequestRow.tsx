import type { ComponentChildren } from "preact";
import { projectWork, workActions, type ContactRequestRecord, type WorkAction, type WorkRecord } from "@humansandmachines/gsv/protocol";
import { RequestDetails } from "./RequestDetails";
import { LoadingState } from "../../../components/ui/Spinner";

export const WORK_LABELS = {
  withdraw: "request a stop", accept: "accept offer", reject: "decline offer", start: "mark started",
  complete: "report result", cancel: "confirm cancellation", acknowledge: "acknowledge result", dispute: "dispute result", reconcile: "sync status",
} as const;
export const WORK_EXPLANATIONS = {
  withdraw: "Ask the other person to stop. They may already have done some work; their cancellation or result report remains separate.",
  accept: "Accept this offer and add it to your Ship's responsibilities. The offer grants no new permissions or access.",
  reject: "Tell the requester you are declining this offer.",
  start: "Tell the requester that work has started.",
  complete: "Report what was completed. The requester can acknowledge or dispute the result.",
  cancel: "Confirm that this work has stopped. Add any partial result or remaining concern in your note.",
  acknowledge: "Tell the performer you acknowledge their reported result.",
  dispute: "Tell the performer what needs attention. This preserves their result report and your response to it.",
  reconcile: "Resend your recorded statements to recover an uncertain delivery. This does not create another task or change the offer.",
} as const;
const STATEMENTS = { withdraw: "Asked to stop", accept: "Accepted", reject: "Declined", start: "Started", complete: "Reported completion", cancel: "Confirmed cancellation", acknowledge: "Acknowledged the result", dispute: "Disputed the result" } satisfies Record<WorkAction, string>;
const STATUS = { offered: "Offer awaiting a decision", accepted: "Accepted", rejected: "Declined", active: "In progress", completed: "Result reported", cancelled: "Cancellation confirmed", withdrawn: "Withdrawal sent · awaiting confirmation", stop_requested: "Stop requested · awaiting confirmation" } as const;

export function WorkRequestRow({ request, work, editable, busy, onAction, children }: {
  request: ContactRequestRecord; work: WorkRecord; editable: boolean; busy: boolean;
  onAction: (action: WorkAction | "reconcile") => void; children?: ComponentChildren;
}) {
  const projection = projectWork(work);
  const exchange = request.exchange?.state ?? "unconfirmed";
  const participant = request.direction === "incoming" ? "performer" : "requester";
  return <article class="fleet-contact-request people-work-request">
    <div class="sub">{request.direction === "incoming" ? "Their request" : "Your request"} · {STATUS[projection.status]}</div>
    <h4>{request.title}</h4>
    {request.details && <details><summary>original offer</summary><RequestDetails value={request.details} /></details>}
    {projection.state === "completed" && <p class="note">{projection.outcome === "acknowledged" ? "Result acknowledged by the requester."
      : projection.outcome === "disputed" ? "The requester has disputed this result. See their note below." : "The requester has not yet acknowledged this result."}</p>}
    {!!(work.requester.length || work.performer.length) && <div class="people-work-statements">{(["requester", "performer"] as const).map((role) => <section key={role}>
      <h5>{role === participant ? "Your statements" : "Their statements"}</h5>
      {work[role].length ? <ol>{work[role].map((operation) => <li key={operation.id}><strong>{STATEMENTS[operation.action]}</strong>{operation.note && <p>{operation.note}</p>}</li>)}</ol>
        : <p class="note">No response yet.</p>}
    </section>)}</div>}
    {exchange === "pending" && <p class="note"><LoadingState>Delivering your recorded update…</LoadingState></p>}
    {exchange === "failed" && <p class="error">Your latest update has not been confirmed. You can sync it again.</p>}
    {exchange === "unconfirmed" && <p class="note">Delivery confirmation is unavailable. These are the last recorded statements.</p>}
    {request.exchange?.lastError && <details class="note"><summary>delivery details</summary><p>{request.exchange.lastError}</p></details>}
    <div class="people-actions">{workActions(work, participant).map((action) => <button class="fleet-text-action" key={action} disabled={!editable || busy} onClick={() => onAction(action)}>{WORK_LABELS[action]}</button>)}
      {(exchange === "failed" || exchange === "unconfirmed") && <button class="fleet-text-action" disabled={!editable || busy} onClick={() => onAction("reconcile")}>sync status</button>}
    </div>
    {children}
  </article>;
}
