import { AccountApi, AccountApiError } from "../api";
import {
  forgetCheckoutOperation,
} from "../billing/checkoutStorage";
import type { CheckoutReturn } from "../billing/useBilling";
import type { AccountSession } from "../telegram/types";
import type { DashboardAction, DashboardView } from "./view";

const CHECKOUT_TARGET_KEY = "gsv.onboarding.checkout-installation";

export async function loadDashboard(
  api: AccountApi,
  session: AccountSession,
  checkoutReturn: CheckoutReturn,
): Promise<DashboardView> {
  const [config, installations, billingResult] = await Promise.all([
    api.publicConfig(),
    api.installations(),
    api.billingOverview().then(
      (billing) => ({ billing, error: undefined }),
      (error) => ({ billing: null, error: publicError(error) }),
    ),
  ]);
  if (billingResult.billing) {
    for (const installation of billingResult.billing.installations) {
      if (installation.subscription) {
        forgetCheckoutOperation(installation.installationId);
      }
    }
  }
  const deletionEntries = await Promise.all(installations
    .filter((installation) => installation.state === "deleting")
    .map(async (installation) => {
      const deletion = await api.installationDeletion(
        installation.installationId,
      );
      return deletion ? [installation.installationId, deletion] as const : null;
    }));
  const usageEntries = await Promise.all(installations
    .filter((installation) => (
      installation.operationState === "complete"
      && installation.state !== "deleted"
    ))
    .map(async (installation) => {
      const usage = await api.installationUsage(installation.installationId)
        .catch(() => null);
      return usage ? [installation.installationId, usage] as const : null;
    }));
  return {
    kind: "dashboard",
    session,
    config,
    installations,
    billing: billingResult.billing,
    ...(billingResult.error ? { billingError: billingResult.error } : {}),
    deletions: Object.fromEntries(
      deletionEntries.filter((entry): entry is NonNullable<typeof entry> => entry !== null),
    ),
    usage: Object.fromEntries(
      usageEntries.filter((entry): entry is NonNullable<typeof entry> => entry !== null),
    ),
    checkoutReturn,
    pending: null,
  };
}

export function actionPrompt(action: DashboardAction): string {
  switch (action.kind) {
    case "create":
      return "Confirm with your passkey before reserving and subscribing to a GSV";
    case "checkout":
      return "Confirm with your passkey before starting a subscription";
    case "portal":
      return "Confirm with your passkey before changing billing";
    case "provision":
      return "Confirm with your passkey before creating your GSV";
    case "enter":
      return "Confirm with your passkey before entering this GSV";
    case "export":
      return "Confirm with your passkey before exporting all of this GSV’s data";
    case "delete":
      return "Confirm with your passkey before requesting deletion";
    case "recover_deletion":
      return "Confirm with your passkey before recovering this GSV";
  }
}

export function publicError(error: unknown): string {
  if (error instanceof AccountApiError || error instanceof Error) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

export function passkeyError(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "The passkey request was cancelled or timed out";
  }
  return publicError(error);
}

export function exportCancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function checkoutSessionMustRestart(error: unknown): boolean {
  if (!(error instanceof AccountApiError) || error.status !== 409) return false;
  const message = error.message.toLowerCase();
  return message.includes("expired") || message.includes("already has a subscription");
}

export function rememberCheckoutTarget(installationId: string): void {
  try {
    sessionStorage.setItem(CHECKOUT_TARGET_KEY, installationId);
  } catch {
    // The installation can still be inferred if it is the only incomplete GSV.
  }
}

export function rememberedCheckoutTarget(): string | null {
  try {
    return sessionStorage.getItem(CHECKOUT_TARGET_KEY);
  } catch {
    return null;
  }
}

export function forgetCheckoutTarget(): void {
  try {
    sessionStorage.removeItem(CHECKOUT_TARGET_KEY);
  } catch {
    // This key contains no credential material and expiry is harmless.
  }
}

export function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
