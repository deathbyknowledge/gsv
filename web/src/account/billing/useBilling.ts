import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  AccountApi,
  AccountApiError,
  type PublicAccountConfig,
} from "../api";
import {
  forgetCheckoutOperation,
  rememberedCheckoutOperation,
  rememberCheckoutOperation,
} from "./checkoutStorage";
import { submitInstallationHandoff } from "../home/navigation";
import { getPasskeyAssertion } from "../passkey";
import type { AccountSession } from "../telegram/types";
import type { BillingOverview } from "./types";

export type CheckoutReturn = "complete" | "cancelled" | null;

type BillingAction = {
  kind: "checkout" | "portal" | "enter";
  installationId: string;
};

export type BillingView =
  | { kind: "loading" }
  | {
      kind: "authentication";
      config: PublicAccountConfig | null;
      pending: boolean;
      prompt: string;
      error?: string;
      resetKey: number;
    }
  | {
      kind: "ready";
      session: AccountSession;
      overview: BillingOverview;
      checkoutReturn: CheckoutReturn;
      pendingInstallationId: string | null;
      error?: string;
    }
  | { kind: "failure"; message: string };

export function useBilling(
  checkoutReturn: CheckoutReturn,
  apiOverride?: AccountApi,
) {
  const api = useMemo(() => apiOverride ?? new AccountApi(), [apiOverride]);
  const [view, setView] = useState<BillingView>({ kind: "loading" });
  const config = useRef<PublicAccountConfig | null>(null);
  const resetKey = useRef(0);
  const pendingAction = useRef<BillingAction | null>(null);
  const operationKeys = useRef(new Map<string, string>());

  useEffect(() => {
    let active = true;
    void bootstrap().catch((error) => {
      if (active) setView({ kind: "failure", message: publicError(error) });
    });
    return () => {
      active = false;
    };

    async function bootstrap() {
      const session = await api.session();
      if (!active) return;
      if (!session.authenticated) {
        await enterAuthentication("Sign in to manage your GSV subscription");
        return;
      }
      const overview = await api.billingOverview();
      forgetSubscribedCheckoutKeys(overview);
      if (active) setView(ready(session, overview, checkoutReturn));
    }

    async function enterAuthentication(prompt: string) {
      setView({
        kind: "authentication",
        config: null,
        pending: true,
        prompt,
        resetKey: resetKey.current,
      });
      config.current ??= await api.publicConfig();
      if (!active) return;
      setView({
        kind: "authentication",
        config: config.current,
        pending: false,
        prompt,
        resetKey: resetKey.current,
      });
    }
  }, [api, checkoutReturn]);

  async function authenticate(turnstileToken: string) {
    if (view.kind !== "authentication" || view.pending) return;
    const authenticationView = view;
    setView({ ...authenticationView, pending: true, error: undefined });
    try {
      const challenge = await api.beginPasskeyAuthentication(turnstileToken);
      const response = await getPasskeyAssertion(challenge.options);
      await api.finishPasskeyAuthentication({
        challengeId: challenge.challengeId,
        response,
      });
      const session = await api.session();
      if (!session.authenticated) {
        throw new Error("The new account session was not available");
      }
      const overview = await api.billingOverview();
      forgetSubscribedCheckoutKeys(overview);
      const next = ready(session, overview, checkoutReturn);
      const action = pendingAction.current;
      pendingAction.current = null;
      if (action) await execute(action, next);
      else setView(next);
    } catch (error) {
      resetKey.current += 1;
      setView({
        ...authenticationView,
        pending: false,
        error: passkeyError(error),
        resetKey: resetKey.current,
      });
    }
  }

  async function startCheckout(installationId: string) {
    if (view.kind !== "ready") return;
    await execute({ kind: "checkout", installationId }, view);
  }

  async function openPortal(installationId: string) {
    if (view.kind !== "ready") return;
    await execute({ kind: "portal", installationId }, view);
  }

  async function enter(installationId: string) {
    if (view.kind !== "ready") return;
    await execute({ kind: "enter", installationId }, view);
  }

  async function execute(
    action: BillingAction,
    current: Extract<BillingView, { kind: "ready" }>,
  ) {
    const installation = current.overview.installations.find(
      (candidate) => candidate.installationId === action.installationId,
    );
    if (!installation) return;
    setView({
      ...current,
      pendingInstallationId: action.installationId,
      error: undefined,
    });
    try {
      if (action.kind === "enter") {
        const handoff = await api.createInstallationHandoff(
          action.installationId,
        );
        submitInstallationHandoff(handoff);
        return;
      }
      const key = `${action.kind}:${action.installationId}`;
      let idempotencyKey = operationKeys.current.get(key)
        ?? (action.kind === "checkout"
          ? rememberedCheckoutOperation(action.installationId)
          : null);
      if (!idempotencyKey) {
        idempotencyKey = crypto.randomUUID();
      }
      operationKeys.current.set(key, idempotencyKey);
      if (action.kind === "checkout") {
        rememberCheckoutOperation(action.installationId, idempotencyKey);
      }
      const hosted = action.kind === "checkout"
        ? await api.createBillingCheckout({
            installationId: action.installationId,
            planKey: current.overview.offer.planKey,
            idempotencyKey,
          })
        : await api.createBillingPortal({
            installationId: action.installationId,
            idempotencyKey,
          });
      window.location.assign(hosted.url);
    } catch (error) {
      if (
        error instanceof AccountApiError
        && (error.status === 401 || error.status === 403)
      ) {
        pendingAction.current = action;
        await enterAuthentication(actionPrompt(action.kind));
        return;
      }
      if (
        action.kind === "checkout"
        && error instanceof AccountApiError
        && error.status === 409
        && (
          error.message.toLowerCase().includes("expired")
          || error.message.toLowerCase().includes("already has a subscription")
        )
      ) {
        operationKeys.current.delete(`${action.kind}:${action.installationId}`);
        forgetCheckoutOperation(action.installationId);
      }
      setView({
        ...current,
        pendingInstallationId: null,
        error: publicError(error),
      });
    }
  }

  async function enterAuthentication(prompt: string) {
    setView({
      kind: "authentication",
      config: null,
      pending: true,
      prompt,
      resetKey: resetKey.current,
    });
    try {
      config.current ??= await api.publicConfig();
      setView({
        kind: "authentication",
        config: config.current,
        pending: false,
        prompt,
        resetKey: resetKey.current,
      });
    } catch (error) {
      setView({ kind: "failure", message: publicError(error) });
    }
  }

  function reload() {
    window.location.reload();
  }

  return { view, authenticate, startCheckout, openPortal, enter, reload };
}

function ready(
  session: AccountSession,
  overview: BillingOverview,
  checkoutReturn: CheckoutReturn,
): Extract<BillingView, { kind: "ready" }> {
  return {
    kind: "ready",
    session,
    overview,
    checkoutReturn,
    pendingInstallationId: null,
  };
}

function passkeyError(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Passkey authentication was cancelled or timed out";
  }
  return publicError(error);
}

function publicError(error: unknown): string {
  if (error instanceof AccountApiError || error instanceof Error) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

function forgetSubscribedCheckoutKeys(overview: BillingOverview): void {
  for (const installation of overview.installations) {
    if (installation.subscription) {
      forgetCheckoutOperation(installation.installationId);
    }
  }
}

function actionPrompt(kind: BillingAction["kind"]): string {
  switch (kind) {
    case "checkout":
      return "Confirm with your passkey before starting a subscription";
    case "portal":
      return "Confirm with your passkey before changing billing";
    case "enter":
      return "Confirm with your passkey before entering this GSV";
  }
}
