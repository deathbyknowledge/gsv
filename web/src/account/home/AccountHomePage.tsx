import { useEffect, useState } from "preact/hooks";
import type { CheckoutReturn } from "../billing/useBilling";
import {
  AccountShell,
  Notice,
  Progress,
  StatusCard,
} from "../shared/AccountShell";
import { AnonymousPanel } from "./AnonymousPanel";
import { Dashboard } from "./Dashboard";
import { PasskeyAuthentication } from "./PasskeyAuthentication";
import type { AccountPageActions } from "./presentation";
import { RecoveryCodesPanel } from "./RecoveryCodesPanel";
import { useAccountHome } from "./useAccountHome";
import type { AccountHomeView, AccountRoute } from "./view";

export function AccountHomePage({
  route,
  verificationToken,
  checkoutReturn,
}: {
  route: AccountRoute;
  verificationToken: string | null;
  checkoutReturn: CheckoutReturn;
}) {
  const account = useAccountHome({ route, verificationToken, checkoutReturn });
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileError, setTurnstileError] = useState(false);
  const challenge = challengeFor(account.view);

  useEffect(() => {
    setTurnstileToken(null);
    setTurnstileError(false);
  }, [challenge?.action, challenge?.resetKey]);

  const actions: AccountPageActions = {
    ...account,
    turnstileToken,
    turnstileError,
    setTurnstileToken,
    setTurnstileError,
  };
  return (
    <AccountShell stageClass="account-home-stage">
      {content(account.view, actions)}
    </AccountShell>
  );
}

function content(view: AccountHomeView, actions: AccountPageActions) {
  if (view.kind === "loading") {
    return (
      <StatusCard title={view.title} copy={view.copy}>
        <Progress />
      </StatusCard>
    );
  }
  if (view.kind === "failure") {
    return (
      <StatusCard title={view.title} copy={view.message} tone="error">
        <div class="account-complete-actions">
          <a class="account-button account-button-primary" href="/">
            RETURN TO GSV ACCOUNT
          </a>
        </div>
      </StatusCard>
    );
  }
  if (view.kind === "anonymous") {
    return <AnonymousPanel view={view} actions={actions} />;
  }
  if (view.kind === "enroll_passkey") {
    return (
      <StatusCard
        title={view.recovery ? "Create your replacement passkey" : "Secure your GSV account"}
        copy={view.recovery
          ? "Your recovery code revoked the old sessions and credentials. Create a new passkey to finish recovery."
          : "A passkey is the key to your managed GSV. It signs you in without another password and confirms sensitive account changes."}
      >
        <div class="account-auth">
          {view.error ? <Notice tone="error">{view.error}</Notice> : null}
          <button
            class="account-button account-button-primary"
            type="button"
            disabled={view.pending}
            onClick={() => void actions.enrollPasskey()}
          >
            {view.pending ? "CREATING PASSKEY…" : "CREATE PASSKEY"}
          </button>
          <p class="account-fineprint">
            Use a device or password manager that can sync or back up this passkey.
          </p>
        </div>
      </StatusCard>
    );
  }
  if (view.kind === "recovery_codes") {
    return <RecoveryCodesPanel view={view} actions={actions} />;
  }
  if (view.kind === "reauthentication") {
    return (
      <PasskeyAuthentication
        config={view.config}
        pending={view.pending}
        prompt={view.prompt}
        resetKey={view.resetKey}
        error={view.error}
        token={actions.turnstileToken}
        turnstileError={actions.turnstileError}
        onToken={actions.setTurnstileToken}
        onTurnstileError={() => actions.setTurnstileError(true)}
        authenticate={actions.authenticate}
        cancel={actions.cancelReauthentication}
      />
    );
  }
  return <Dashboard view={view} actions={actions} />;
}

function challengeFor(view: AccountHomeView): {
  action: "signup" | "recovery" | "passkey_login";
  resetKey: number;
} | null {
  if (view.kind === "reauthentication") {
    return { action: "passkey_login", resetKey: view.resetKey };
  }
  if (view.kind !== "anonymous") return null;
  return {
    action: view.mode === "signup"
      ? "signup"
      : view.mode === "recovery"
        ? "recovery"
        : "passkey_login",
    resetKey: view.resetKey,
  };
}
