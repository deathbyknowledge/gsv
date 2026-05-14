import type { HilRequest } from "../../types";
import { CheckIcon, XIcon } from "../../icons";
import { describeHilSummary, describeToolCard } from "../../view-helpers";
import { ToolDetails } from "./ToolCard";

export function HilCard(props: { request: HilRequest; busy: boolean; onDecision(requestId: string, decision: "approve" | "deny", remember?: boolean): void }) {
  const card = describeToolCard(props.request.toolName, props.request.args, props.request.syscall);
  return (
    <article class="tool-card is-pending">
      <div class="tool-card-head">
        <div>
          <h3>{card.title}</h3>
          {card.subtitle ? <p>{card.subtitle}</p> : null}
        </div>
        <span class="tool-status is-pending">Awaiting approval<span>{card.target}</span></span>
      </div>
      <div class="tool-preview">
        <p>{describeHilSummary(props.request, props.request.syscall)}</p>
        <p>This tool will not run until you decide.</p>
      </div>
      <div class="approval-actions">
        <button class="icon-button approve" type="button" title="Allow tool call" aria-label="Allow tool call" disabled={props.busy} onClick={() => props.onDecision(props.request.requestId, "approve")}>
          <CheckIcon />
        </button>
        <button class="secondary-button approval-remember" type="button" title="Allow this tool for this process" disabled={props.busy} onClick={() => props.onDecision(props.request.requestId, "approve", true)}>
          <CheckIcon />
          <span>Always allow</span>
        </button>
        <button class="icon-button deny" type="button" title="Deny tool call" aria-label="Deny tool call" disabled={props.busy} onClick={() => props.onDecision(props.request.requestId, "deny")}>
          <XIcon />
        </button>
      </div>
      <details class="tool-details">
        <summary>Details</summary>
        <ToolDetails row={{ kind: "toolCall", toolName: props.request.toolName, callId: props.request.callId, args: props.request.args, syscall: props.request.syscall, timestamp: props.request.createdAt }} syscall={props.request.syscall} />
      </details>
    </article>
  );
}
