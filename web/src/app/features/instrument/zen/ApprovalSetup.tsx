import { APPROVAL_CATEGORIES, type ApprovalCategoryId, type ApprovalChoice, type ApprovalChoices, type ApprovalPolicyAction } from "../../../domain/agentApproval";

export type ApprovalSetupProps = {
  step: 1 | 2;
  /** The person's explicit picks; a row without one shows what the policy does today. */
  choices: ApprovalChoices;
  /** What the account's policy does today, per row; a denied row is shown as blocked. */
  current: Record<ApprovalCategoryId, ApprovalPolicyAction>;
  /** False when the account cannot write its policy: the card explains and offers no picks. */
  editable: boolean;
  saving: boolean;
  error: string | null;
  onChoose: (id: ApprovalCategoryId, choice: ApprovalChoice) => void;
  onContinue: () => void;
  onClose: () => void;
};

/** The Ship's word on approvals, opened from the card's "why am I being asked?": what runs on its own, then what to ask about. */
export function ApprovalSetup({ step, choices, current, editable, saving, error, onChoose, onContinue, onClose }: ApprovalSetupProps) {
  const asking = APPROVAL_CATEGORIES.filter((category) => current[category.id] === "ask").map((category) => category.label);
  return (
    <div class="zen-approval is-setup">
      <div class="q">{step === 1 ? "approval · why I ask" : "approval · what to ask about"}</div>
      {step === 1 ? (
        <>
          <p class="ask">
            For most of what I do, I don't need to bother you. In the ship I read and write files, run commands,
            search the web and open pages. On your machines I read and search without asking (you see all of it in the receipt under
            each answer, after the fact).
          </p>
          <p class="ask">{asking.length ? `Before these, I ask: ${asking.join(" · ")}.` : "Right now I don't ask before anything."}</p>
          {editable ? (
            <p class="ask">If you don't want to see some of these again, pick what I may do on my own.</p>
          ) : (
            <p class="consequence">Changing that needs an account that can edit settings.</p>
          )}
          <div class="keys">
            <button type="button" class="ibtn is-primary" onClick={editable ? onContinue : onClose}>
              <kbd>c</kbd> {editable ? "go on" : "got it"}
            </button>
            {editable ? (
              <>
                <button type="button" class="ibtn" onClick={onClose}>
                  <kbd>s</kbd> close
                </button>
                <span>close and nothing changes</span>
              </>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <p class="ask">Pick a side for each. You can change any of it later.</p>
          <ul class="rows" aria-label="What to ask about">
            {APPROVAL_CATEGORIES.map((category) => {
              const picked = choices[category.id] ?? current[category.id];
              const blocked = current[category.id] === "deny";
              return (
                <li key={category.id}>
                  <span class="row-label">{category.label}</span>
                  <span class="row-example">{category.example}</span>
                  <span class="row-pick">
                    {blocked ? <span class="row-blocked">blocked</span> : null}
                    <button type="button" class="ibtn" aria-pressed={picked === "auto"} disabled={saving || blocked} onClick={() => onChoose(category.id, "auto")}>allow</button>
                    <button type="button" class="ibtn" aria-pressed={picked === "ask"} disabled={saving || blocked} onClick={() => onChoose(category.id, "ask")}>ask</button>
                  </span>
                </li>
              );
            })}
          </ul>
          {error ? <p class="consequence is-err" role="alert">{`that didn't save: ${error}`}</p> : null}
          <div class="keys">
            <button type="button" class="ibtn is-primary" disabled={saving} onClick={onContinue}>
              <kbd>c</kbd> {error ? "try again" : "save it"}
            </button>
            <button type="button" class="ibtn" disabled={saving} onClick={onClose}>
              <kbd>s</kbd> close
            </button>
            <span>{saving ? "saving…" : "ask me any time to change these, or open settings, top right or ,"}</span>
          </div>
        </>
      )}
    </div>
  );
}
