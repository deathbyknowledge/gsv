import { TurnstileWidget } from "../TurnstileWidget";
import type { PublicAccountConfig } from "../api";
import { Notice, StatusCard } from "../shared/AccountShell";
import type { AccountPageActions } from "./presentation";

export function PasskeyAuthentication({
  config,
  pending,
  prompt,
  resetKey,
  error,
  token,
  turnstileError,
  onToken,
  onTurnstileError,
  authenticate,
  cancel,
}: {
  config: PublicAccountConfig;
  pending: boolean;
  prompt: string;
  resetKey: number;
  error?: string;
  token: string | null;
  turnstileError: boolean;
  onToken: (token: string | null) => void;
  onTurnstileError: () => void;
  authenticate: AccountPageActions["authenticate"];
  cancel?: () => void;
}) {
  const siteKey = config.turnstileSiteKey;
  const body = (
    <div class="account-auth">
      <BotCheck
        action="passkey_login"
        siteKey={siteKey}
        resetKey={resetKey}
        error={turnstileError}
        onToken={onToken}
        onError={onTurnstileError}
      />
      {error ? <Notice tone="error">{error}</Notice> : null}
      <button
        class="account-button account-button-primary"
        type="button"
        disabled={!siteKey || !token || pending}
        onClick={() => {
          if (token) void authenticate(token);
        }}
      >
        {pending ? "WAITING…" : "CONTINUE WITH PASSKEY"}
      </button>
      {cancel ? (
        <button
          class="account-button account-button-secondary"
          type="button"
          disabled={pending}
          onClick={cancel}
        >
          CANCEL
        </button>
      ) : null}
    </div>
  );
  return cancel ? (
    <StatusCard title="Confirm it’s you" copy={prompt}>{body}</StatusCard>
  ) : body;
}

export function BotCheck({
  action,
  siteKey,
  resetKey,
  error,
  onToken,
  onError,
}: {
  action: "signup" | "recovery" | "passkey_login";
  siteKey: string | null;
  resetKey: number;
  error: boolean;
  onToken: (token: string | null) => void;
  onError: () => void;
}) {
  if (!siteKey) {
    return <Notice tone="error">Secure browser verification is not configured yet.</Notice>;
  }
  return (
    <>
      <TurnstileWidget
        siteKey={siteKey}
        action={action}
        resetKey={resetKey}
        onToken={onToken}
        onError={onError}
      />
      {error ? (
        <Notice tone="error">
          The browser check could not load. Check your connection and try again.
        </Notice>
      ) : null}
    </>
  );
}
