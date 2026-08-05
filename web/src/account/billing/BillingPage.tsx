import { useEffect, useState } from "preact/hooks";
import { TurnstileWidget } from "../TurnstileWidget";
import {
  AccountShell,
  Notice,
  Progress,
  StatusCard,
} from "../shared/AccountShell";
import {
  billingDeadline,
  billingState,
  monthlyPrice,
} from "./domain";
import type { BillingInstallation } from "./types";
import {
  type BillingView,
  type CheckoutReturn,
  useBilling,
} from "./useBilling";

export function BillingPage({
  checkoutReturn,
}: {
  checkoutReturn: CheckoutReturn;
}) {
  const {
    view,
    authenticate,
    startCheckout,
    openPortal,
    enter,
    reload,
  } = useBilling(checkoutReturn);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileError, setTurnstileError] = useState(false);
  const resetKey = view.kind === "authentication" ? view.resetKey : -1;

  useEffect(() => {
    setTurnstileToken(null);
    setTurnstileError(false);
  }, [resetKey]);

  return (
    <AccountShell
      stageClass="account-billing-stage"
      footer="Payment details stay in Stripe’s hosted checkout and portal."
    >
      {content(view, {
        turnstileToken,
        turnstileError,
        setTurnstileToken,
        setTurnstileError,
        authenticate,
        startCheckout,
        openPortal,
        enter,
        reload,
      })}
    </AccountShell>
  );
}

type PageActions = {
  turnstileToken: string | null;
  turnstileError: boolean;
  setTurnstileToken: (token: string | null) => void;
  setTurnstileError: (value: boolean) => void;
  authenticate: (turnstileToken: string) => Promise<void>;
  startCheckout: (installationId: string) => Promise<void>;
  openPortal: (installationId: string) => Promise<void>;
  enter: (installationId: string) => Promise<void>;
  reload: () => void;
};

function content(view: BillingView, actions: PageActions) {
  if (view.kind === "loading") {
    return (
      <StatusCard title="Loading your GSV" copy="Checking service and subscription state…">
        <Progress />
      </StatusCard>
    );
  }
  if (view.kind === "failure") {
    return (
      <StatusCard title="Billing is unavailable" copy={view.message} tone="error">
        <button class="account-button account-button-secondary" type="button" onClick={actions.reload}>
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
              action="passkey_login"
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
            Billing changes require a recent passkey confirmation. GSV never receives your card details.
          </p>
        </div>
      </StatusCard>
    );
  }

  const price = monthlyPrice(
    view.overview.offer.monthlyPriceMinor,
    view.overview.offer.currency,
  );
  return (
    <div class="account-card account-link-card account-billing-card">
      <div class="account-card-heading">
        <div>
          <h1>Your managed GSV</h1>
          <p>
            One subscription keeps your personal intelligence available on the web and Telegram, with managed storage and GSV Intelligence included.
          </p>
        </div>
        <span class="account-state">{price} / MONTH</span>
      </div>

      <dl class="account-summary account-billing-summary">
        <div>
          <dt>ACCOUNT</dt>
          <dd>
            <strong>{view.session.principal.displayName}</strong>
            <span>{view.session.principal.email}</span>
          </dd>
        </div>
        <div>
          <dt>FOUNDING PRICE</dt>
          <dd>
            <strong>{price} monthly</strong>
            <span>No permanent hosted free tier</span>
          </dd>
        </div>
        <div>
          <dt>INCLUDED</dt>
          <dd>
            <strong>GSV Intelligence</strong>
            <span>Web, storage, processes, Telegram</span>
          </dd>
        </div>
      </dl>

      {view.checkoutReturn === "complete" ? (
        <Notice tone="success">
          Checkout returned successfully. Activation happens only after GSV verifies the payment confirmation; this page may take a moment to update.
        </Notice>
      ) : null}
      {view.checkoutReturn === "cancelled" ? (
        <Notice tone="warning">
          Checkout was cancelled. Your current GSV state has not changed.
        </Notice>
      ) : null}
      {view.error ? <Notice tone="error">{view.error}</Notice> : null}

      <div class="account-billing-installations">
        {view.overview.installations.length === 0 ? (
          <div class="account-billing-empty">
            <strong>No GSV is ready for billing yet.</strong>
            <p>Finish choosing your GSV name first, then return here to activate it.</p>
          </div>
        ) : view.overview.installations.map((installation) => (
          <InstallationBilling
            key={installation.installationId}
            installation={installation}
            price={price}
            pending={view.pendingInstallationId === installation.installationId}
            disabled={view.pendingInstallationId !== null}
            startCheckout={actions.startCheckout}
            openPortal={actions.openPortal}
            enter={actions.enter}
          />
        ))}
      </div>
    </div>
  );
}

function InstallationBilling({
  installation,
  price,
  pending,
  disabled,
  startCheckout,
  openPortal,
  enter,
}: {
  installation: BillingInstallation;
  price: string;
  pending: boolean;
  disabled: boolean;
  startCheckout: (installationId: string) => Promise<void>;
  openPortal: (installationId: string) => Promise<void>;
  enter: (installationId: string) => Promise<void>;
}) {
  const subscription = installation.subscription;
  const state = subscription ? billingState(subscription.state) : null;
  const deadline = billingDeadline(installation);
  const hostname = new URL(installation.canonicalOrigin).hostname;
  return (
    <section class="account-billing-installation">
      <div class="account-billing-installation-heading">
        <div>
          <span class="account-installation-index">GSV</span>
          <h2>{installation.handle}</h2>
          <p>{hostname}</p>
        </div>
        <span class={`account-billing-state account-tone-${state?.tone ?? "neutral"}`}>
          {state?.label ?? "NOT SUBSCRIBED"}
        </span>
      </div>

      {subscription ? (
        <div class="account-billing-detail">
          <div>
            <span>PLAN</span>
            <strong>Managed GSV · {price}/month</strong>
          </div>
          {deadline ? (
            <div>
              <span>{deadline.label}</span>
              <strong>{formatDate(deadline.at)}</strong>
            </div>
          ) : null}
        </div>
      ) : (
        <p class="account-billing-copy">
          Activate this GSV with the founding plan. Checkout is hosted by Stripe; returning from checkout alone never grants service.
        </p>
      )}

      <div class="account-billing-actions">
        {subscription ? (
          <button
            class="account-button account-button-primary"
            type="button"
            disabled={disabled}
            onClick={() => void openPortal(installation.installationId)}
          >
            {pending ? "OPENING…" : "MANAGE BILLING"}
          </button>
        ) : (
          <button
            class="account-button account-button-primary"
            type="button"
            disabled={disabled}
            onClick={() => void startCheckout(installation.installationId)}
          >
            {pending ? "OPENING CHECKOUT…" : `START FOR ${price.toUpperCase()} / MONTH`}
          </button>
        )}
        {installation.installationState === "active" ? (
          <button
            class="account-button account-button-secondary"
            type="button"
            disabled={disabled}
            onClick={() => void enter(installation.installationId)}
          >
            {pending ? "OPENING…" : "OPEN GSV"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(value);
}
