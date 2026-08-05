import type { ManagedInstallation } from "./types";

const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_HANDLES = new Set([
  "admin",
  "api",
  "app",
  "accounts",
  "assets",
  "auth",
  "billing",
  "bot",
  "cdn",
  "dashboard",
  "deploy",
  "docs",
  "inference",
  "install",
  "login",
  "mail",
  "oauth",
  "status",
  "support",
  "telegram",
  "webhooks",
  "www",
]);
const MAX_VERIFICATION_TOKEN_LENGTH = 512;

export function verificationTokenFromHash(hash: string): string | null {
  if (!hash.startsWith("#")) return null;
  const token = new URLSearchParams(hash.slice(1)).get("token");
  if (
    !token
    || token.length > MAX_VERIFICATION_TOKEN_LENGTH
    || token.trim() !== token
    || /\s/.test(token)
  ) {
    return null;
  }
  return token;
}

export function normalizeHandle(value: string): string {
  return value.trim().toLowerCase();
}

export function handleError(value: string): string | null {
  const handle = normalizeHandle(value);
  if (!handle) return "Choose a name for your GSV";
  if (RESERVED_HANDLES.has(handle)) return "That GSV name is reserved";
  if (!HANDLE_PATTERN.test(handle)) {
    return "Use 1–63 lowercase letters, numbers, or hyphens; begin and end with a letter or number";
  }
  return null;
}

export function ownerUsernameForHandle(handleValue: string): string {
  const handle = normalizeHandle(handleValue);
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(handle) ? handle : "owner";
}

export function installationStatus(installation: ManagedInstallation): {
  label: string;
  tone: "neutral" | "success" | "warning" | "error";
  copy: string;
} {
  if (installation.state === "deleting") {
    return {
      label: "DELETION PENDING",
      tone: "warning",
      copy: "New work is paused while the installation lifecycle advances.",
    };
  }
  if (installation.state === "deleted") {
    return {
      label: "DELETED",
      tone: "error",
      copy: "This GSV and its installation-owned data have been deleted.",
    };
  }
  if (installation.operationState === "failed") {
    return {
      label: "SETUP NEEDS ATTENTION",
      tone: "error",
      copy: "Your name is reserved and setup can be safely retried.",
    };
  }
  if (installation.operationState !== "complete") {
    if (!installation.entitlement) {
      return {
        label: "AWAITING SUBSCRIPTION",
        tone: "neutral",
        copy: "Activate the founding plan to finish creating this GSV.",
      };
    }
    return {
      label: "READY TO CREATE",
      tone: "neutral",
      copy: "Payment is confirmed. GSV can now initialize your personal intelligence.",
    };
  }
  if (installation.state === "past_due") {
    return {
      label: "PAYMENT NEEDS ATTENTION",
      tone: "warning",
      copy: "Your GSV remains available during the payment grace period.",
    };
  }
  if (installation.state === "restricted") {
    return {
      label: "RESTRICTED",
      tone: "error",
      copy: "New paid work is paused; login, inspection, export, and deletion remain available.",
    };
  }
  if (installation.state === "cancelled") {
    return {
      label: "ENDS THIS PERIOD",
      tone: "warning",
      copy: "Service remains available through the paid period.",
    };
  }
  if (installation.state === "retained") {
    return {
      label: "DATA RETAINED",
      tone: "error",
      copy: "Service has ended. Export your data or restore billing before retention expires.",
    };
  }
  return {
    label: installation.state === "trialing" ? "TRIAL ACTIVE" : "ONLINE",
    tone: "success",
    copy: "Your GSV is ready on the web and can be connected to Telegram.",
  };
}

export function canEnterInstallation(installation: ManagedInstallation): boolean {
  return installation.operationState === "complete"
    && installation.state !== "reserved"
    && installation.state !== "provisioning"
    && installation.state !== "deleting"
    && installation.state !== "deleted";
}

export function canProvisionInstallation(installation: ManagedInstallation): boolean {
  return installation.entitlement !== null
    && installation.operationState !== "complete"
    && installation.state !== "deleting"
    && installation.state !== "deleted";
}

export function needsSubscription(installation: ManagedInstallation): boolean {
  return installation.entitlement === null
    && installation.operationState !== "complete"
    && installation.state === "reserved";
}

export function checkoutProvisioningTarget(
  installations: readonly ManagedInstallation[],
  rememberedInstallationId: string | null,
): ManagedInstallation | null {
  if (rememberedInstallationId) {
    const remembered = installations.find((installation) => (
      installation.installationId === rememberedInstallationId
      && installation.state !== "deleted"
    ));
    if (remembered) return remembered;
  }
  const candidates = installations.filter((installation) => (
    installation.operationState !== "complete"
    && installation.state !== "deleting"
    && installation.state !== "deleted"
  ));
  return candidates.length === 1 ? candidates[0]! : null;
}
