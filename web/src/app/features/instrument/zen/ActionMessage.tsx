import { conversationActionText, type ConversationAction } from "@humansandmachines/gsv/protocol";
import { actionSubtitle, actionTitle } from "./chatContextModel";

export function ActionMessage({ action, onOpen }: { action: ConversationAction; onOpen: (action: ConversationAction) => void }) {
  return <div class={`zen-action-message is-${action.kind.split(".")[0]}`}>
    <span class="zen-action-kind">{actionSubtitle(action)}</span>
    <button type="button" class="zen-action-title" onClick={() => onOpen(action)}>{actionTitle(action)} <span aria-hidden="true">↗</span></button>
    {action.note && <p class="zen-action-note">{action.note}</p>}
    <details class="zen-action-request"><summary>request</summary><p>{conversationActionText(action)}</p></details>
  </div>;
}
