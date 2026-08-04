import { useEffect, useState } from "preact/hooks";
import { installationHostname, telegramIdentity } from "./domain";
import { TurnstileWidget } from "../TurnstileWidget";
import { useTelegramLink, type TelegramLinkView } from "./useTelegramLink";

export function TelegramLinkPage({ claimToken }: { claimToken: string | null }) {
  const {
    view,
    authenticate,
    confirm,
    selectInstallation,
    restart,
  } = useTelegramLink(claimToken);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileError, setTurnstileError] = useState(false);
  const resetKey = view.kind === "authentication" ? view.resetKey : -1;

  useEffect(() => {
    setTurnstileToken(null);
    setTurnstileError(false);
  }, [resetKey]);

  return (
    <main class="account-page">
      <div class="account-grid" aria-hidden="true" />
      <header class="account-header">
        <a class="account-brand" href="https://gsv.space" aria-label="GSV home">
          <img src="/brand/gsv-mark-white.svg" alt="" />
          <span>GSV</span>
        </a>
        <span class="account-product">PERSONAL INTELLIGENCE</span>
      </header>

      <section class="account-stage" aria-live="polite">
        <div class="account-service-mark">
          <img src="/icons/telegram.svg" alt="" />
        </div>
        <p class="account-eyebrow">MANAGED TELEGRAM</p>
        {content(view, {
          turnstileToken,
          turnstileError,
          setTurnstileToken,
          setTurnstileError,
          authenticate,
          confirm,
          selectInstallation,
          restart,
        })}
      </section>

      <footer class="account-footer">
        <span>accounts.gsv.space</span>
        <span>Telegram never receives your account credentials.</span>
      </footer>
    </main>
  );
}

type PageActions = {
  turnstileToken: string | null;
  turnstileError: boolean;
  setTurnstileToken: (token: string | null) => void;
  setTurnstileError: (value: boolean) => void;
  authenticate: (turnstileToken: string) => Promise<void>;
  confirm: () => Promise<void>;
  selectInstallation: (installationId: string) => void;
  restart: () => void;
};

function content(view: TelegramLinkView, actions: PageActions) {
  if (view.kind === "loading") {
    return (
      <StatusCard title="Checking your link" copy="Verifying the Telegram request…">
        <Progress />
      </StatusCard>
    );
  }
  if (view.kind === "missing_claim") {
    return (
      <StatusCard
        title="Open a fresh Telegram link"
        copy="This page needs the private connection link sent by the GSV bot. Return to Telegram and request a new one."
        tone="warning"
      />
    );
  }
  if (view.kind === "claim_rejected") {
    const copy = view.reason === "expired"
      ? "This connection link expired. Return to Telegram and request a new one."
      : view.reason === "used"
        ? "This connection link has already been used. Request a new one in Telegram if you want to change the destination."
        : "This connection link is not valid. Return to Telegram and request a new one.";
    return <StatusCard title="This link cannot be used" copy={copy} tone="warning" />;
  }
  if (view.kind === "failure") {
    return (
      <StatusCard title="We could not check this link" copy={view.message} tone="error">
        <button class="account-button account-button-secondary" type="button" onClick={actions.restart}>
          TRY AGAIN
        </button>
      </StatusCard>
    );
  }
  if (view.kind === "authentication") {
    const siteKey = view.config?.turnstileSiteKey ?? null;
    return (
      <StatusCard title="Confirm it’s you" copy={view.prompt}>
        <div class="account-auth">
          {view.pending && !view.config ? <Progress /> : null}
          {!view.pending && !siteKey ? (
            <Notice tone="error">
              Passkey sign-in is not configured on this account service yet.
            </Notice>
          ) : null}
          {siteKey ? (
            <TurnstileWidget
              siteKey={siteKey}
              resetKey={view.resetKey}
              onToken={actions.setTurnstileToken}
              onError={() => actions.setTurnstileError(true)}
            />
          ) : null}
          {actions.turnstileError ? (
            <Notice tone="error">
              The browser check could not load. Check your connection and try again.
            </Notice>
          ) : null}
          {view.error ? <Notice tone="error">{view.error}</Notice> : null}
          <button
            class="account-button account-button-primary"
            type="button"
            disabled={!siteKey || !actions.turnstileToken || view.pending}
            onClick={() => {
              if (actions.turnstileToken) {
                void actions.authenticate(actions.turnstileToken);
              }
            }}
          >
            {view.pending ? "WAITING…" : "CONTINUE WITH PASSKEY"}
          </button>
          <p class="account-fineprint">
            GSV uses a passkey here because this changes where your private messages are delivered.
          </p>
        </div>
      </StatusCard>
    );
  }
  if (view.kind === "complete") {
    const hostname = installationHostname(view.link.installation);
    return (
      <StatusCard
        title="Telegram is connected"
        copy={`New messages to the GSV bot will now reach ${hostname}. The bot has sent you a confirmation.`}
        tone="success"
      >
        <div class="account-complete-actions">
          <a
            class="account-button account-button-primary"
            href={view.link.installation.canonicalOrigin}
          >
            OPEN {view.link.installation.handle.toUpperCase()}.GSV.SPACE
          </a>
          <button
            class="account-button account-button-secondary"
            type="button"
            onClick={() => window.history.back()}
          >
            RETURN TO TELEGRAM
          </button>
        </div>
      </StatusCard>
    );
  }

  const identity = telegramIdentity(view.inspection.claim);
  const expires = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(view.inspection.claim.expiresAt);
  return (
    <div class="account-card account-link-card">
      <div class="account-card-heading">
        <div>
          <h1>Choose its GSV</h1>
          <p>
            Confirm which personal intelligence can receive messages from this Telegram account.
          </p>
        </div>
        <span class="account-state">LINK REQUEST</span>
      </div>

      <dl class="account-summary">
        <div>
          <dt>TELEGRAM</dt>
          <dd>
            <strong>{identity.primary}</strong>
            {identity.secondary ? <span>{identity.secondary}</span> : null}
          </dd>
        </div>
        <div>
          <dt>SIGNED IN</dt>
          <dd>
            <strong>{view.session.principal.displayName}</strong>
            <span>{view.session.principal.email}</span>
          </dd>
        </div>
        <div>
          <dt>LINK EXPIRES</dt>
          <dd><strong>{expires}</strong></dd>
        </div>
      </dl>

      {view.inspection.installations.length > 0 ? (
        <form
          class="account-installation-form"
          onSubmit={(event) => {
            event.preventDefault();
            void actions.confirm();
          }}
        >
          <fieldset>
            <legend>SELECT A GSV</legend>
            <div class="account-installations">
              {view.inspection.installations.map((installation, index) => {
                const selected = view.selectedInstallationId
                  === installation.installationId;
                return (
                  <label
                    class={`account-installation${selected ? " is-selected" : ""}`}
                    key={installation.canonicalOrigin}
                  >
                    <input
                      type="radio"
                      name="installation"
                      checked={selected}
                      onChange={() => actions.selectInstallation(
                        installation.installationId,
                      )}
                    />
                    <span class="account-installation-index">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span class="account-installation-name">
                      <strong>{installation.handle}</strong>
                      <span>{installationHostname(installation)}</span>
                    </span>
                    <span class="account-installation-role">
                      {installation.role.toUpperCase()}
                    </span>
                    <span class="account-radio" aria-hidden="true" />
                  </label>
                );
              })}
            </div>
          </fieldset>

          {view.inspection.claim.linked ? (
            <Notice tone="warning">
              This Telegram account is already connected. Confirming moves future messages to the selected GSV.
            </Notice>
          ) : null}
          {view.error ? <Notice tone="error">{view.error}</Notice> : null}
          <button
            class="account-button account-button-primary"
            type="submit"
            disabled={!view.selectedInstallationId || view.pending}
          >
            {view.pending
              ? "CONNECTING…"
              : view.inspection.claim.linked
                ? "MOVE TELEGRAM ACCESS"
                : "CONNECT TELEGRAM"}
          </button>
        </form>
      ) : (
        <Notice tone="warning">
          This account has no active GSV yet. Create or restore one before connecting Telegram.
        </Notice>
      )}
    </div>
  );
}

function StatusCard({
  title,
  copy,
  tone = "neutral",
  children,
}: {
  title: string;
  copy: string;
  tone?: "neutral" | "warning" | "error" | "success";
  children?: preact.ComponentChildren;
}) {
  return (
    <div class={`account-card account-status-card account-tone-${tone}`}>
      <span class="account-status-light" aria-hidden="true" />
      <h1>{title}</h1>
      <p>{copy}</p>
      {children}
    </div>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: "warning" | "error";
  children: preact.ComponentChildren;
}) {
  return <p class={`account-notice account-notice-${tone}`}>{children}</p>;
}

function Progress() {
  return (
    <span class="account-progress" role="status">
      <span />
      <span />
      <span />
      <span class="account-sr-only">Working</span>
    </span>
  );
}
