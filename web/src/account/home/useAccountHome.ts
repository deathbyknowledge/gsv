import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  AccountApi,
  AccountApiError,
} from "../api";
import {
  forgetCheckoutOperation,
  rememberedCheckoutOperation,
  rememberCheckoutOperation,
} from "../billing/checkoutStorage";
import type { CheckoutReturn } from "../billing/useBilling";
import { createPasskey, getPasskeyAssertion } from "../passkey";
import type { AccountSession } from "../telegram/types";
import {
  checkoutProvisioningTarget,
  ownerUsernameForHandle,
} from "./domain";
import {
  saveInstallationExport,
  submitInstallationHandoff,
} from "./navigation";
import {
  actionPrompt,
  checkoutSessionMustRestart,
  exportCancelled,
  forgetCheckoutTarget,
  loadDashboard,
  passkeyError,
  publicError,
  rememberedCheckoutTarget,
  rememberCheckoutTarget,
  wait,
} from "./model";
import type {
  AccountHomeView,
  AccountRoute,
  AnonymousMode,
  DashboardAction,
  DashboardView,
} from "./view";

export function useAccountHome(
  input: {
    route: AccountRoute;
    verificationToken: string | null;
    checkoutReturn: CheckoutReturn;
  },
  apiOverride?: AccountApi,
) {
  const api = useMemo(() => apiOverride ?? new AccountApi(), [apiOverride]);
  const [view, setView] = useState<AccountHomeView>({
    kind: "loading",
    title: "Opening your account",
    copy: "Checking your secure GSV session…",
  });
  const pendingAction = useRef<DashboardAction | null>(null);
  const resetKey = useRef(0);

  useEffect(() => {
    let active = true;
    void bootstrap().catch((error) => {
      if (active) {
        setView({
          kind: "failure",
          title: "Your account could not be opened",
          message: publicError(error),
        });
      }
    });
    return () => {
      active = false;
    };

    async function bootstrap(): Promise<void> {
      let knownSession: Awaited<ReturnType<AccountApi["session"]>> | null = null;
      if (input.route === "verify") {
        if (!input.verificationToken) {
          // The fragment is intentionally scrubbed before rendering. A refresh
          // after successful verification must resume the new account session
          // instead of demanding the already-consumed email credential again.
          knownSession = await api.session();
          if (!active) return;
          if (!knownSession.authenticated) {
            setView({
              kind: "failure",
              title: "This verification link is incomplete",
              message: "Open the complete link from your GSV verification email, or start signup again.",
            });
            return;
          }
        } else {
          setView({
            kind: "loading",
            title: "Verifying your email",
            copy: "This one-time link is being checked…",
          });
          await api.verifyEmail(input.verificationToken);
        }
      }

      const session = knownSession ?? await api.session();
      if (!active) return;
      if (!session.authenticated) {
        const config = await api.publicConfig();
        if (!active) return;
        setView({
          kind: "anonymous",
          mode: input.route === "recover" ? "recovery" : "signup",
          config,
          pending: false,
          resetKey: resetKey.current,
          emailSent: false,
        });
        return;
      }
      if (session.principal.state !== "active" || session.authMethod !== "passkey") {
        setView({
          kind: "enroll_passkey",
          session,
          pending: false,
          recovery: session.principal.state === "recovery",
        });
        return;
      }
      if (input.checkoutReturn === "complete") {
        await finishCheckout(session, () => active);
        return;
      }
      const dashboard = await loadDashboard(api, session, input.checkoutReturn);
      if (active) {
        setView({
          ...dashboard,
          ...(input.checkoutReturn === "cancelled"
            ? { notice: "Checkout was cancelled. Your GSV name remains reserved for a short time." }
            : {}),
        });
      }
    }
  }, [api, input.route, input.verificationToken, input.checkoutReturn]);

  function setAnonymousMode(mode: AnonymousMode): void {
    if (view.kind !== "anonymous" || view.pending) return;
    setView({
      ...view,
      mode,
      emailSent: false,
      error: undefined,
    });
  }

  async function signup(input: {
    displayName: string;
    email: string;
    turnstileToken: string;
  }): Promise<void> {
    if (view.kind !== "anonymous" || view.pending) return;
    const previous = view;
    setView({ ...previous, pending: true, error: undefined });
    try {
      await api.requestSignup(input);
      resetKey.current += 1;
      setView({
        ...previous,
        pending: false,
        resetKey: resetKey.current,
        emailSent: true,
      });
    } catch (error) {
      resetKey.current += 1;
      setView({
        ...previous,
        pending: false,
        resetKey: resetKey.current,
        error: publicError(error),
      });
    }
  }

  async function recover(input: {
    email: string;
    code: string;
    turnstileToken: string;
  }): Promise<void> {
    if (view.kind !== "anonymous" || view.pending) return;
    const previous = view;
    setView({ ...previous, pending: true, error: undefined });
    try {
      await api.recoverWithCode(input);
      const session = await requireAuthenticatedSession();
      setView({
        kind: "enroll_passkey",
        session,
        pending: false,
        recovery: true,
      });
    } catch (error) {
      resetKey.current += 1;
      setView({
        ...previous,
        pending: false,
        resetKey: resetKey.current,
        error: publicError(error),
      });
    }
  }

  async function authenticate(turnstileToken: string): Promise<void> {
    if (
      (view.kind !== "anonymous" || view.mode !== "login")
      && view.kind !== "reauthentication"
    ) {
      return;
    }
    if (view.pending) return;
    const previous = view;
    setView({ ...previous, pending: true, error: undefined });
    try {
      const challenge = await api.beginPasskeyAuthentication(turnstileToken);
      const response = await getPasskeyAssertion(challenge.options);
      await api.finishPasskeyAuthentication({
        challengeId: challenge.challengeId,
        response,
      });
      const session = await requireAuthenticatedSession();
      if (previous.kind === "reauthentication") {
        const action = pendingAction.current;
        pendingAction.current = null;
        const dashboard = await loadDashboard(api, session, null);
        if (action) await executeDashboardAction(action, dashboard);
        else setView(dashboard);
        return;
      }
      setView(await loadDashboard(api, session, null));
    } catch (error) {
      resetKey.current += 1;
      setView({
        ...previous,
        pending: false,
        resetKey: resetKey.current,
        error: passkeyError(error),
      });
    }
  }

  async function enrollPasskey(): Promise<void> {
    if (view.kind !== "enroll_passkey" || view.pending) return;
    const previous = view;
    setView({ ...previous, pending: true, error: undefined });
    try {
      const challenge = await api.beginPasskeyRegistration();
      const response = await createPasskey(challenge.options);
      const result = await api.finishPasskeyRegistration({
        challengeId: challenge.challengeId,
        response,
      });
      const session = await requireAuthenticatedSession();
      setView({
        kind: "recovery_codes",
        session,
        codes: result.recoveryCodes,
        pending: false,
      });
    } catch (error) {
      setView({ ...previous, pending: false, error: passkeyError(error) });
    }
  }

  async function acknowledgeRecoveryCodes(): Promise<void> {
    if (view.kind !== "recovery_codes" || view.pending) return;
    const previous = view;
    setView({ ...previous, pending: true, error: undefined });
    try {
      setView(await loadDashboard(api, previous.session, null));
    } catch (error) {
      setView({ ...previous, pending: false, error: publicError(error) });
    }
  }

  async function refresh(): Promise<void> {
    const dashboard = view.kind === "dashboard"
      ? view
      : view.kind === "reauthentication"
        ? view.previous
        : null;
    if (!dashboard) return;
    setView({
      kind: "loading",
      title: "Refreshing your GSV",
      copy: "Checking installation and subscription state…",
    });
    try {
      setView(await loadDashboard(api, dashboard.session, null));
    } catch (error) {
      setView({ ...dashboard, pending: null, error: publicError(error) });
    }
  }

  async function createGsv(handle: string): Promise<void> {
    await dispatch({
      kind: "create",
      handle,
      reservationKey: crypto.randomUUID(),
      checkoutKey: crypto.randomUUID(),
    });
  }

  async function startCheckout(installationId: string): Promise<void> {
    await dispatch({
      kind: "checkout",
      installationId,
      idempotencyKey: rememberedCheckoutOperation(installationId)
        ?? crypto.randomUUID(),
    });
  }

  async function openBillingPortal(installationId: string): Promise<void> {
    await dispatch({
      kind: "portal",
      installationId,
      idempotencyKey: crypto.randomUUID(),
    });
  }

  async function provision(installationId: string): Promise<void> {
    await dispatch({ kind: "provision", installationId, enterAfter: true });
  }

  async function enter(installationId: string): Promise<void> {
    await dispatch({ kind: "enter", installationId });
  }

  async function exportInstallation(installationId: string): Promise<void> {
    await dispatch({ kind: "export", installationId });
  }

  async function deleteInstallation(input: {
    installationId: string;
    confirmedHandle: string;
  }): Promise<void> {
    await dispatch({
      kind: "delete",
      ...input,
      idempotencyKey: crypto.randomUUID(),
    });
  }

  async function recoverDeletion(installationId: string): Promise<void> {
    await dispatch({ kind: "recover_deletion", installationId });
  }

  async function logout(): Promise<void> {
    try {
      await api.logout();
      window.location.assign("/");
    } catch (error) {
      const dashboard = view.kind === "dashboard" ? view : null;
      if (dashboard) setView({ ...dashboard, error: publicError(error) });
    }
  }

  function cancelReauthentication(): void {
    if (view.kind !== "reauthentication" || view.pending) return;
    pendingAction.current = null;
    setView(view.previous);
  }

  async function dispatch(action: DashboardAction): Promise<void> {
    if (view.kind !== "dashboard" || view.pending) return;
    await executeDashboardAction(action, view);
  }

  async function executeDashboardAction(
    action: DashboardAction,
    dashboard: DashboardView,
  ): Promise<void> {
    let checkoutInstallationId = action.kind === "checkout"
      ? action.installationId
      : null;
    setView({
      ...dashboard,
      pending: {
        kind: action.kind,
        ...(action.kind === "create" ? {} : { installationId: action.installationId }),
      },
      error: undefined,
      notice: undefined,
    });
    try {
      switch (action.kind) {
        case "create": {
          if (!dashboard.billing) {
            throw new Error(dashboard.billingError ?? "Billing is temporarily unavailable");
          }
          const installation = await api.reserveInstallation({
            idempotencyKey: action.reservationKey,
            handle: action.handle,
            ownerUsername: ownerUsernameForHandle(action.handle),
            agentName: "GSV",
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          });
          checkoutInstallationId = installation.installationId;
          rememberCheckoutTarget(installation.installationId);
          rememberCheckoutOperation(
            installation.installationId,
            action.checkoutKey,
          );
          const hosted = await api.createBillingCheckout({
            installationId: installation.installationId,
            planKey: dashboard.billing.offer.planKey,
            idempotencyKey: action.checkoutKey,
          });
          window.location.assign(hosted.url);
          return;
        }
        case "checkout": {
          if (!dashboard.billing) {
            throw new Error(dashboard.billingError ?? "Billing is temporarily unavailable");
          }
          rememberCheckoutTarget(action.installationId);
          rememberCheckoutOperation(
            action.installationId,
            action.idempotencyKey,
          );
          const hosted = await api.createBillingCheckout({
            installationId: action.installationId,
            planKey: dashboard.billing.offer.planKey,
            idempotencyKey: action.idempotencyKey,
          });
          window.location.assign(hosted.url);
          return;
        }
        case "portal": {
          const hosted = await api.createBillingPortal({
            installationId: action.installationId,
            idempotencyKey: action.idempotencyKey,
          });
          window.location.assign(hosted.url);
          return;
        }
        case "provision": {
          const installation = await api.provisionInstallation(action.installationId);
          if (action.enterAfter && installation.operationState === "complete") {
            const handoff = await api.createInstallationHandoff(
              installation.installationId,
            );
            forgetCheckoutTarget();
            forgetCheckoutOperation(installation.installationId);
            submitInstallationHandoff(handoff);
            return;
          }
          setView(await loadDashboard(api, dashboard.session, null));
          return;
        }
        case "enter": {
          const handoff = await api.createInstallationHandoff(action.installationId);
          submitInstallationHandoff(handoff);
          return;
        }
        case "export": {
          const archive = await api.requestInstallationExport(action.installationId);
          await saveInstallationExport(archive);
          setView({
            ...(await loadDashboard(api, dashboard.session, null)),
            notice: "Your complete GSV export was saved.",
          });
          return;
        }
        case "delete": {
          await api.requestInstallationDeletion(action);
          setView({
            ...(await loadDashboard(api, dashboard.session, null)),
            notice: "Deletion was requested. You can recover this GSV during the seven-day recovery window.",
          });
          return;
        }
        case "recover_deletion": {
          await api.recoverInstallationDeletion(action.installationId);
          setView({
            ...(await loadDashboard(api, dashboard.session, null)),
            notice: "Deletion was cancelled and your GSV was recovered.",
          });
          return;
        }
      }
    } catch (error) {
      if (
        error instanceof AccountApiError
        && (error.status === 401 || error.status === 403)
      ) {
        pendingAction.current = action;
        await beginReauthentication(dashboard, actionPrompt(action));
        return;
      }
      if (checkoutInstallationId && checkoutSessionMustRestart(error)) {
        forgetCheckoutOperation(checkoutInstallationId);
      }
      let refreshed = dashboard;
      if (action.kind === "create") {
        refreshed = await loadDashboard(api, dashboard.session, null).catch(() => dashboard);
      }
      setView({
        ...refreshed,
        pending: null,
        error: exportCancelled(error)
          ? "Export was cancelled. No data was changed."
          : publicError(error),
      });
    }
  }

  async function beginReauthentication(
    dashboard: DashboardView,
    prompt: string,
  ): Promise<void> {
    try {
      const config = await api.publicConfig();
      setView({
        kind: "reauthentication",
        previous: { ...dashboard, pending: null },
        config,
        pending: false,
        prompt,
        resetKey: resetKey.current,
      });
    } catch (error) {
      pendingAction.current = null;
      setView({ ...dashboard, pending: null, error: publicError(error) });
    }
  }

  async function finishCheckout(
    session: AccountSession,
    isActive: () => boolean,
  ): Promise<void> {
    const deadline = Date.now() + 45_000;
    while (isActive()) {
      const dashboard = await loadDashboard(api, session, "complete");
      const target = checkoutProvisioningTarget(
        dashboard.installations,
        rememberedCheckoutTarget(),
      );
      if (!target) {
        setView({
          ...dashboard,
          error: "Payment returned, but GSV could not identify one installation to continue. Choose Finish setup below.",
        });
        return;
      }
      if (target.operationState === "complete") {
        try {
          const handoff = await api.createInstallationHandoff(target.installationId);
          forgetCheckoutTarget();
          forgetCheckoutOperation(target.installationId);
          if (isActive()) submitInstallationHandoff(handoff);
        } catch (error) {
          setView({ ...dashboard, error: publicError(error) });
        }
        return;
      }
      if (target.entitlement) {
        forgetCheckoutOperation(target.installationId);
        setView({
          kind: "loading",
          title: `Creating ${target.handle}.gsv.space`,
          copy: "Initializing your private runtime, storage, and first personal agent…",
        });
        try {
          const installation = await api.provisionInstallation(target.installationId);
          if (installation.operationState === "complete") {
            const handoff = await api.createInstallationHandoff(
              installation.installationId,
            );
            forgetCheckoutTarget();
            forgetCheckoutOperation(installation.installationId);
            if (isActive()) submitInstallationHandoff(handoff);
            return;
          }
        } catch (error) {
          if (!(error instanceof AccountApiError) || error.status !== 503) {
            setView({ ...dashboard, error: publicError(error) });
            return;
          }
        }
      } else {
        setView({
          kind: "loading",
          title: "Confirming your subscription",
          copy: "GSV is waiting for Stripe’s signed payment confirmation. The browser return alone never activates service…",
        });
      }
      if (Date.now() >= deadline) {
        setView({
          ...dashboard,
          notice: "Payment confirmation is still arriving. Refresh this page in a moment; setup will remain safely resumable.",
        });
        return;
      }
      await wait(1_500);
    }
  }

  async function requireAuthenticatedSession(): Promise<AccountSession> {
    const session = await api.session();
    if (!session.authenticated) {
      throw new Error("The new account session was not available");
    }
    return session;
  }

  return {
    view,
    setAnonymousMode,
    signup,
    recover,
    authenticate,
    enrollPasskey,
    acknowledgeRecoveryCodes,
    refresh,
    createGsv,
    startCheckout,
    openBillingPortal,
    provision,
    enter,
    exportInstallation,
    deleteInstallation,
    recoverDeletion,
    logout,
    cancelReauthentication,
  };
}
