import { useState } from "preact/hooks";
import { monthlyPrice } from "../billing/domain";
import { Notice } from "../shared/AccountShell";
import {
  canEnterInstallation,
  canProvisionInstallation,
  handleError,
  installationStatus,
  needsSubscription,
  normalizeHandle,
} from "./domain";
import type { AccountPageActions } from "./presentation";
import type { ManagedInstallation } from "./types";
import type { DashboardView } from "./view";

export function Dashboard({
  view,
  actions,
}: {
  view: DashboardView;
  actions: AccountPageActions;
}) {
  const price = view.billing
    ? monthlyPrice(
        view.billing.offer.monthlyPriceMinor,
        view.billing.offer.currency,
      )
    : "$20";
  return (
    <div class="account-card account-dashboard">
      <div class="account-dashboard-heading">
        <div>
          <p class="account-kicker">GSV ACCOUNT</p>
          <h1>{view.session.principal.displayName}</h1>
          <p>{view.session.principal.email}</p>
        </div>
        <div class="account-dashboard-account-actions">
          <a class="account-text-action" href="/billing">BILLING</a>
          <button class="account-text-action" type="button" onClick={() => void actions.logout()}>
            SIGN OUT
          </button>
        </div>
      </div>

      {view.notice ? <Notice tone="success">{view.notice}</Notice> : null}
      {view.checkoutReturn === "complete" ? (
        <Notice tone="warning">
          Checkout returned successfully. GSV still waits for the signed payment confirmation before provisioning.
        </Notice>
      ) : null}
      {view.error ? <Notice tone="error">{view.error}</Notice> : null}
      {view.billingError ? (
        <Notice tone="warning">
          Billing status is temporarily unavailable. Your GSV, export, and deletion controls remain accessible.
        </Notice>
      ) : null}

      {view.installations.length === 0 ? (
        <CreateGsvPanel
          price={price}
          disabled={view.pending !== null || !view.billing}
          create={actions.createGsv}
        />
      ) : (
        <div class="account-dashboard-body">
          <div class="account-dashboard-section-heading">
            <div>
              <span>YOUR GSV</span>
            </div>
            <button
              class="account-text-action"
              type="button"
              disabled={view.pending !== null}
              onClick={() => void actions.refresh()}
            >
              REFRESH
            </button>
          </div>
          <div class="account-gsv-list">
            {view.installations.map((installation) => (
              <InstallationRow
                key={installation.installationId}
                installation={installation}
                view={view}
                actions={actions}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CreateGsvPanel({
  price,
  disabled,
  create,
}: {
  price: string;
  disabled: boolean;
  create: (handle: string) => Promise<void>;
}) {
  return (
    <section class="account-create-panel">
      <div>
        <p class="account-kicker">YOUR PERSONAL INTELLIGENCE</p>
        <h2>Give it a place of its own.</h2>
        <p>
          Choose the permanent address you will use on the web. GSV handles the runtime, storage, GSV Intelligence, and Telegram adapter.
        </p>
      </div>
      <HandleForm price={price} disabled={disabled} create={create} />
    </section>
  );
}

function HandleForm({
  price,
  disabled,
  create,
}: {
  price: string;
  disabled: boolean;
  create: (handle: string) => Promise<void>;
}) {
  const [handle, setHandle] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const normalized = normalizeHandle(handle);
  const error = handleError(handle);
  return (
    <form
      class="account-handle-form"
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        if (!error) void create(normalized);
      }}
    >
      <label class="account-field">
        <span>GSV ADDRESS</span>
        <span class="account-domain-input">
          <input
            name="handle"
            autocomplete="off"
            autocapitalize="none"
            spellcheck={false}
            maxlength={63}
            value={handle}
            disabled={disabled}
            onInput={(event) => setHandle(event.currentTarget.value.toLowerCase())}
            placeholder="hank"
            aria-describedby="handle-help"
          />
          <span>.gsv.space</span>
        </span>
      </label>
      {submitted && error ? <Notice tone="error">{error}</Notice> : null}
      <button
        class="account-button account-button-primary"
        type="submit"
        disabled={disabled || !!error}
      >
        CONTINUE TO {price.toUpperCase()} / MONTH
      </button>
      <p class="account-fineprint" id="handle-help">
        Your address cannot be renamed at launch. Checkout opens on Stripe; only its signed confirmation activates GSV.
      </p>
    </form>
  );
}

function InstallationRow({
  installation,
  view,
  actions,
}: {
  installation: ManagedInstallation;
  view: DashboardView;
  actions: AccountPageActions;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmedHandle, setConfirmedHandle] = useState("");
  const status = installationStatus(installation);
  const billing = view.billing?.installations.find((candidate) => (
    candidate.installationId === installation.installationId
  ));
  const deletion = view.deletions[installation.installationId];
  const usage = view.usage[installation.installationId];
  const pending = view.pending?.installationId === installation.installationId;
  const disabled = view.pending !== null;
  const hostname = new URL(installation.canonicalOrigin).hostname;
  return (
    <section class={`account-gsv-row account-tone-${status.tone}`}>
      <div class="account-gsv-main">
        <span class="account-status-light" aria-hidden="true" />
        <div class="account-gsv-identity">
          <h2>{installation.handle}</h2>
          <span>{hostname}</span>
        </div>
        <div class="account-gsv-status">
          <strong>{status.label}</strong>
          <span>{status.copy}</span>
        </div>
      </div>

      {usage && usage.level !== "normal" ? (
        <div class="account-usage-warning">
          <Notice tone={usage.level === "exhausted" ? "error" : "warning"}>
            {usage.level === "exhausted"
              ? <>This GSV has reached its included GSV Intelligence allowance. Account access, export, deletion, and bring-your-own-provider options remain available.</>
              : <>This GSV has used {usage.usedPercent}% of its included GSV Intelligence allowance. It resets {formatDateTime(usage.periodEndsAt)}.</>}
          </Notice>
        </div>
      ) : null}

      {deletion ? (
        <div class="account-deletion-banner">
          <div>
            <strong>{deletion.state === "deleting" ? "PERMANENT DELETION STARTED" : "RECOVERY WINDOW OPEN"}</strong>
            <span>
              {deletion.state === "deleting"
                ? "The recovery deadline passed and bounded teardown is in progress."
                : `Recover before ${formatDateTime(deletion.recoverableUntil)}.`}
            </span>
          </div>
          {deletion.state !== "deleting" && deletion.recoverableUntil > Date.now() ? (
            <button
              class="account-button account-button-primary"
              type="button"
              disabled={disabled}
              onClick={() => void actions.recoverDeletion(installation.installationId)}
            >
              {pending ? "RECOVERING…" : "RECOVER GSV"}
            </button>
          ) : null}
        </div>
      ) : null}

      <div class="account-gsv-actions">
        {canEnterInstallation(installation) ? (
          <button
            class="account-button account-button-primary"
            type="button"
            disabled={disabled}
            onClick={() => void actions.enter(installation.installationId)}
          >
            {pending ? "OPENING…" : "OPEN GSV"}
          </button>
        ) : canProvisionInstallation(installation) ? (
          <button
            class="account-button account-button-primary"
            type="button"
            disabled={disabled}
            onClick={() => void actions.provision(installation.installationId)}
          >
            {pending ? "CREATING…" : "FINISH SETUP"}
          </button>
        ) : needsSubscription(installation) && !billing?.subscription ? (
          <button
            class="account-button account-button-primary"
            type="button"
            disabled={disabled || !view.billing}
            onClick={() => void actions.startCheckout(installation.installationId)}
          >
            {pending ? "OPENING…" : "ACTIVATE SUBSCRIPTION"}
          </button>
        ) : null}
        {billing?.subscription ? (
          <button
            class="account-button account-button-secondary"
            type="button"
            disabled={disabled}
            onClick={() => void actions.openBillingPortal(installation.installationId)}
          >
            MANAGE BILLING
          </button>
        ) : null}
        {installation.operationState === "complete" && installation.state !== "deleted" ? (
          <button
            class="account-button account-button-secondary"
            type="button"
            disabled={disabled}
            onClick={() => void actions.exportInstallation(installation.installationId)}
          >
            {pending && view.pending?.kind === "export" ? "EXPORTING…" : "EXPORT"}
          </button>
        ) : null}
        {canEnterInstallation(installation) && view.config.telegramBotUsername ? (
          <a
            class="account-button account-button-secondary"
            href={`https://t.me/${view.config.telegramBotUsername}`}
            target="_blank"
            rel="noreferrer"
          >
            OPEN TELEGRAM
          </a>
        ) : null}
      </div>

      {installation.state !== "deleted" && !deletion ? (
        <details class="account-gsv-advanced">
          <summary>DATA, TELEGRAM, AND DELETION</summary>
          <div class="account-gsv-advanced-body">
            <p>
              {view.config.telegramBotUsername
                ? <>Telegram is included. Message @{view.config.telegramBotUsername} and use its private account link to choose {hostname}; Telegram never becomes an account credential.</>
                : <>Telegram is included and will appear here when the managed bot is activated; Telegram never becomes an account credential.</>}
            </p>
            {!confirmingDelete ? (
              <button
                class="account-danger-link"
                type="button"
                disabled={disabled || installation.operationState !== "complete"}
                onClick={() => setConfirmingDelete(true)}
              >
                REQUEST GSV DELETION
              </button>
            ) : (
              <form
                class="account-delete-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (confirmedHandle === installation.handle) {
                    void actions.deleteInstallation({
                      installationId: installation.installationId,
                      confirmedHandle,
                    });
                  }
                }}
              >
                <Notice tone="warning">
                  This immediately stops new work, cancels billing, and opens a seven-day recovery window. After it closes, GSV permanently deletes the installation-owned runtime, repositories, media, inference state, and Telegram route.
                </Notice>
                <label class="account-field">
                  <span>TYPE {installation.handle.toUpperCase()} TO CONFIRM</span>
                  <input
                    value={confirmedHandle}
                    autocomplete="off"
                    spellcheck={false}
                    onInput={(event) => setConfirmedHandle(event.currentTarget.value)}
                  />
                </label>
                <div class="account-delete-actions">
                  <button
                    class="account-button account-button-danger"
                    type="submit"
                    disabled={disabled || confirmedHandle !== installation.handle}
                  >
                    REQUEST DELETION
                  </button>
                  <button
                    class="account-button account-button-secondary"
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      setConfirmingDelete(false);
                      setConfirmedHandle("");
                    }}
                  >
                    CANCEL
                  </button>
                </div>
              </form>
            )}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function formatDateTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}
