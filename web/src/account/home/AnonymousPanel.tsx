import { useState } from "preact/hooks";
import { Notice } from "../shared/AccountShell";
import { BotCheck, PasskeyAuthentication } from "./PasskeyAuthentication";
import type { AccountPageActions } from "./presentation";
import type {
  AccountHomeView,
  AnonymousMode,
} from "./view";

export function AnonymousPanel({
  view,
  actions,
}: {
  view: Extract<AccountHomeView, { kind: "anonymous" }>;
  actions: AccountPageActions;
}) {
  const siteKey = view.config.turnstileSiteKey;
  return (
    <div class="account-card account-auth-card">
      <div class="account-auth-intro">
        <p class="account-kicker">YOUR GSV</p>
        <h1>{anonymousTitle(view.mode)}</h1>
        <p>{anonymousCopy(view.mode)}</p>
      </div>
      <nav class="account-mode-switch" aria-label="Account action">
        <ModeButton mode="signup" current={view.mode} select={actions.setAnonymousMode}>
          CREATE ACCOUNT
        </ModeButton>
        <ModeButton mode="login" current={view.mode} select={actions.setAnonymousMode}>
          SIGN IN
        </ModeButton>
        <ModeButton mode="recovery" current={view.mode} select={actions.setAnonymousMode}>
          RECOVER
        </ModeButton>
      </nav>

      {view.emailSent ? (
        <div class="account-auth-form">
          <Notice tone="success">
            If this address can continue signup, a fresh verification link is on its way. The link expires in 20 minutes.
          </Notice>
          <button
            class="account-button account-button-secondary"
            type="button"
            onClick={() => actions.setAnonymousMode("login")}
          >
            I ALREADY HAVE A PASSKEY
          </button>
        </div>
      ) : view.mode === "signup" ? (
        <SignupForm view={view} actions={actions} siteKey={siteKey} />
      ) : view.mode === "recovery" ? (
        <RecoveryForm view={view} actions={actions} siteKey={siteKey} />
      ) : (
        <PasskeyAuthentication
          config={view.config}
          pending={view.pending}
          prompt="Use the passkey saved on your device or in your password manager."
          resetKey={view.resetKey}
          error={view.error}
          token={actions.turnstileToken}
          turnstileError={actions.turnstileError}
          onToken={actions.setTurnstileToken}
          onTurnstileError={() => actions.setTurnstileError(true)}
          authenticate={actions.authenticate}
        />
      )}
    </div>
  );
}

function SignupForm({
  view,
  actions,
  siteKey,
}: {
  view: Extract<AccountHomeView, { kind: "anonymous" }>;
  actions: AccountPageActions;
  siteKey: string | null;
}) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  return (
    <form
      class="account-auth-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (actions.turnstileToken) {
          void actions.signup({
            displayName,
            email,
            turnstileToken: actions.turnstileToken,
          });
        }
      }}
    >
      <label class="account-field">
        <span>YOUR NAME</span>
        <input
          name="name"
          autocomplete="name"
          maxlength={100}
          required
          value={displayName}
          onInput={(event) => setDisplayName(event.currentTarget.value)}
          placeholder="Hank"
        />
      </label>
      <label class="account-field">
        <span>RECOVERY EMAIL</span>
        <input
          name="email"
          type="email"
          autocomplete="email"
          maxlength={254}
          required
          value={email}
          onInput={(event) => setEmail(event.currentTarget.value)}
          placeholder="you@example.com"
        />
      </label>
      <BotCheck
        action="signup"
        siteKey={siteKey}
        resetKey={view.resetKey}
        error={actions.turnstileError}
        onToken={actions.setTurnstileToken}
        onError={() => actions.setTurnstileError(true)}
      />
      {view.error ? <Notice tone="error">{view.error}</Notice> : null}
      <button
        class="account-button account-button-primary"
        type="submit"
        disabled={
          !siteKey
          || !actions.turnstileToken
          || view.pending
          || !displayName.trim()
          || !email.trim()
        }
      >
        {view.pending ? "SENDING LINK…" : "VERIFY EMAIL"}
      </button>
      <p class="account-fineprint">
        Next: create a passkey, choose your GSV address, and activate the founding plan.
      </p>
    </form>
  );
}

function RecoveryForm({
  view,
  actions,
  siteKey,
}: {
  view: Extract<AccountHomeView, { kind: "anonymous" }>;
  actions: AccountPageActions;
  siteKey: string | null;
}) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  return (
    <form
      class="account-auth-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (actions.turnstileToken) {
          void actions.recover({
            email,
            code,
            turnstileToken: actions.turnstileToken,
          });
        }
      }}
    >
      <label class="account-field">
        <span>ACCOUNT EMAIL</span>
        <input
          name="email"
          type="email"
          autocomplete="email"
          maxlength={254}
          required
          value={email}
          onInput={(event) => setEmail(event.currentTarget.value)}
        />
      </label>
      <label class="account-field">
        <span>ONE-TIME RECOVERY CODE</span>
        <input
          class="account-code-input"
          name="recovery-code"
          autocomplete="one-time-code"
          spellcheck={false}
          required
          value={code}
          onInput={(event) => setCode(event.currentTarget.value.toUpperCase())}
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
        />
      </label>
      <BotCheck
        action="recovery"
        siteKey={siteKey}
        resetKey={view.resetKey}
        error={actions.turnstileError}
        onToken={actions.setTurnstileToken}
        onError={() => actions.setTurnstileError(true)}
      />
      {view.error ? <Notice tone="error">{view.error}</Notice> : null}
      <button
        class="account-button account-button-primary"
        type="submit"
        disabled={
          !siteKey
          || !actions.turnstileToken
          || view.pending
          || !email.trim()
          || !code.trim()
        }
      >
        {view.pending ? "RECOVERING…" : "REVOKE OLD ACCESS AND CONTINUE"}
      </button>
      <p class="account-fineprint">
        Recovery revokes every existing GSV account session, passkey, and unused recovery code.
      </p>
    </form>
  );
}

function ModeButton({
  mode,
  current,
  select,
  children,
}: {
  mode: AnonymousMode;
  current: AnonymousMode;
  select: (mode: AnonymousMode) => void;
  children: preact.ComponentChildren;
}) {
  return (
    <button
      type="button"
      class={current === mode ? "is-active" : ""}
      aria-current={current === mode ? "page" : undefined}
      onClick={() => select(mode)}
    >
      {children}
    </button>
  );
}

function anonymousTitle(mode: AnonymousMode): string {
  if (mode === "login") return "Welcome back.";
  if (mode === "recovery") return "Recover your account.";
  return "Meet your GSV.";
}

function anonymousCopy(mode: AnonymousMode): string {
  if (mode === "login") {
    return "Open your account and enter your managed GSV with one passkey.";
  }
  if (mode === "recovery") {
    return "Use one saved recovery code to revoke old access and create a replacement passkey.";
  }
  return "A durable personal intelligence with its own address, memory, tools, and Telegram connection—without deploying infrastructure.";
}
