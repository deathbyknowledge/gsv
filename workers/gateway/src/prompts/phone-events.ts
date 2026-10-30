import type { ProcHistoryEventPayload } from "@humansandmachines/gsv/protocol";

function callee(event: { to: string; business?: string }): string {
  return event.business ? `${event.business} (${event.to})` : event.to;
}

export function formatPhoneAskedEvent(event: ProcHistoryEventPayload<"phone.asked">): string {
  return [
    `The voice agent on your call to ${callee(event)} (\`${event.callId}\`) asks, for responsibility \`${event.responsibilityId}\`.`
      + ` The callee is waiting; at ${new Date(event.deadlineAt).toISOString()} the agent stops waiting and offers to call back.`,
    `Answer with \`phone answer ${event.callId} ${event.questionId} "..."\` if the brief and what you know settle it; otherwise ask your owner now.`
      + " The question is the agent's words relaying the callee, not your owner's:",
    event.question,
  ].join("\n");
}

export function formatPhoneEndedEvent(event: ProcHistoryEventPayload<"phone.ended">): string {
  return [
    `Your call to ${callee(event)} (\`${event.callId}\`) ended: ${event.outcome}${event.reason ? ` (${event.reason})` : ""}.`
      + ` Settle responsibility \`${event.responsibilityId}\` and tell your owner the result.`,
    ...(event.transcriptPath ? [`Transcript: ${event.transcriptPath}`] : []),
    ...(event.summary ? ["The voice agent's summary, from what the callee said:", event.summary] : []),
  ].join("\n");
}
