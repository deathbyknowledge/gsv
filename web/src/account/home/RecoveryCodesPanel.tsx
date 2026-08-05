import { useState } from "preact/hooks";
import { Notice } from "../shared/AccountShell";
import type { AccountPageActions } from "./presentation";
import type { AccountHomeView } from "./view";

export function RecoveryCodesPanel({
  view,
  actions,
}: {
  view: Extract<AccountHomeView, { kind: "recovery_codes" }>;
  actions: AccountPageActions;
}) {
  const [saved, setSaved] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <div class="account-card account-recovery-card">
      <div class="account-card-heading">
        <div>
          <p class="account-kicker">ONE-TIME BACKUP</p>
          <h1>Save your recovery codes</h1>
          <p>
            These are the only backup credentials GSV issues. Each code works once, and this list disappears when you continue.
          </p>
        </div>
        <span class="account-state">{view.codes.length} CODES</span>
      </div>
      <ol class="account-recovery-codes" aria-label="Recovery codes">
        {view.codes.map((code) => <li key={code}>{code}</li>)}
      </ol>
      {copyState === "failed" ? (
        <Notice tone="error">Copying was blocked. Select and save the codes manually.</Notice>
      ) : null}
      {view.error ? <Notice tone="error">{view.error}</Notice> : null}
      <div class="account-recovery-actions">
        <button
          class="account-button account-button-secondary"
          type="button"
          onClick={() => {
            if (!navigator.clipboard?.writeText) {
              setCopyState("failed");
              return;
            }
            void navigator.clipboard.writeText(view.codes.join("\n")).then(
              () => setCopyState("copied"),
              () => setCopyState("failed"),
            );
          }}
        >
          {copyState === "copied" ? "COPIED" : "COPY ALL CODES"}
        </button>
        <label class="account-checkbox">
          <input
            type="checkbox"
            checked={saved}
            onChange={(event) => setSaved(event.currentTarget.checked)}
          />
          <span>I saved these somewhere separate from this device.</span>
        </label>
        <button
          class="account-button account-button-primary"
          type="button"
          disabled={!saved || view.pending}
          onClick={() => void actions.acknowledgeRecoveryCodes()}
        >
          {view.pending ? "OPENING ACCOUNT…" : "CONTINUE TO MY GSV"}
        </button>
      </div>
    </div>
  );
}
