import type { ComponentChildren } from "preact";
import { APPROVAL_CATEGORIES, type ApprovalCategoryId, type ApprovalChoice, type ApprovalChoices, type ApprovalPolicyAction } from "../../../domain/agentApproval";
import type { AccountApprovalBlock } from "../shared/useAccountApproval";
import type { ApprovalSetupStage } from "./useApprovalSetup";

export type ApprovalSetupProps = {
  stage: ApprovalSetupStage;
  /** The signed-in person, named on the rows that echo their choice. */
  who: string;
  /** False while the person is still reading the Ship's message; the box (or the Ship's answer) comes after. */
  revealed: boolean;
  /** The person's explicit picks; a row without one shows what the policy does today. */
  choices: ApprovalChoices;
  /** What the account's policy does today, per row; a denied row is shown as blocked. */
  current: Record<ApprovalCategoryId, ApprovalPolicyAction>;
  blocked: AccountApprovalBlock | null;
  saving: boolean;
  error: string | null;
  onAllowAll: () => void;
  onLimit: () => void;
  onDetail: () => void;
  onChoose: (id: ApprovalCategoryId, choice: ApprovalChoice) => void;
  onSave: () => void;
  onWhy: () => void;
  onClose: () => void;
};

/** The Ship's word on approvals, opened from the card's "why am I being asked?": ordinary Ship messages, each followed by a box of choices. */
export function ApprovalSetup({ stage, who, revealed, choices, current, blocked, saving, error, onAllowAll, onLimit, onDetail, onChoose, onSave, onWhy, onClose }: ApprovalSetupProps) {
  const asking = APPROVAL_CATEGORIES.filter((category) => current[category.id] === "ask").map((category) => category.label);
  const failure = error ? <p class="consequence is-err" role="alert">{`that didn't save: ${error}`}</p> : null;
  if (stage === "blocked" || stage === "why") {
    return (
      <>
        <div class="zen-moment is-approval"><div class="zen-approval is-setup">
          <p class="ask">Sorry, but this user can't edit those settings.</p>
          <div class="keys">
            <button type="button" class="ibtn is-primary" onClick={onClose}>got it</button>
            {stage === "blocked" ? <button type="button" class="ibtn" onClick={onWhy}>why?</button> : null}
          </div>
        </div></div>
        {stage === "why" ? youSay(who, "why?") : null}
        {stage === "why" && revealed ? shipSays(blocked === "policy"
          ? <p>The saved approval rules use settings this card can't rewrite safely. Someone with settings access can edit them in Settings → permissions.</p>
          : <p>Approval rules are part of this account's permissions, and this account doesn't have the permission to change settings. The owner of this space can grant it, or change the rules themselves in Settings → permissions.</p>) : null}
      </>
    );
  }
  return (
    <>
      {shipSays(<>
        <p>For most of what I do in the ship, I don't need to bother you. I only ask before sensitive tasks.</p>
      </>)}
      {stage === "ask" ? !revealed ? null : (
        <div class="zen-moment is-approval"><div class="zen-approval is-setup">
          <p class="ask">Do you want me to stop asking?</p>
          <div class="options">
            <button type="button" class="ibtn" disabled={saving} onClick={onAllowAll}>Yes, turn on auto-approve for everything</button>
            <button type="button" class="ibtn" disabled={saving} onClick={onLimit}>Only ask before deleting something or contacting someone</button>
            <button type="button" class="ibtn" disabled={saving} onClick={onDetail}>What are sensitive tasks?</button>
            <button type="button" class="ibtn" disabled={saving} onClick={onClose}>No, keep asking.</button>
          </div>
          {failure}
          {saving ? <p class="consequence">saving…</p> : null}
        </div></div>
      ) : (
        <>
          {youSay(who, "What are sensitive tasks?")}
          {shipSays(<>
            {asking.length ? <>
              <p>Right now I ask before:</p>
              <ul>{asking.map((label) => <li key={label}>{label}</li>)}</ul>
            </> : <p>Right now I don't ask before anything.</p>}
            <p>If you don't want to see some of these again, pick what I may do on my own.</p>
          </>)}
          {!revealed ? null : <div class="zen-moment is-approval"><div class="zen-approval is-setup">
            <ul class="rows" aria-label="What to ask about">
              {APPROVAL_CATEGORIES.map((category) => {
                const picked = choices[category.id] ?? current[category.id];
                const denied = current[category.id] === "deny";
                return (
                  <li key={category.id}>
                    <span class="row-label">{category.label}</span>
                    <span class="row-example">{category.example}</span>
                    <span class="row-pick">
                      {denied ? <span class="row-blocked">blocked</span> : null}
                      <button type="button" class="ibtn" aria-pressed={picked === "auto"} disabled={saving || denied} onClick={() => onChoose(category.id, "auto")}>allow</button>
                      <button type="button" class="ibtn" aria-pressed={picked === "ask"} disabled={saving || denied} onClick={() => onChoose(category.id, "ask")}>ask</button>
                    </span>
                  </li>
                );
              })}
            </ul>
            {failure}
            <div class="keys">
              <button type="button" class="ibtn is-primary" disabled={saving} onClick={onSave}>{error ? "try again" : "save it"}</button>
              <button type="button" class="ibtn" disabled={saving} onClick={onClose}>close</button>
              <span>{saving ? "saving…" : "you can change any of it later in settings, top right or ,"}</span>
            </div>
          </div></div>}
        </>
      )}
    </>
  );
}

/** The person's chosen option, echoed as their own message so the exchange reads as a conversation. */
function youSay(who: string, text: string) {
  return (
    <div class="zen-moment is-human is-explain">
      <div class="who">{who}</div>
      <div class="text">{text}</div>
    </div>
  );
}

/** A Ship message the client authors: the same row as a reply, without a timestamp since nothing was sent. */
function shipSays(children: ComponentChildren) {
  return (
    <div class="zen-moment is-ship is-explain">
      <div class="who">ship</div>
      <div class="text">{children}</div>
    </div>
  );
}
