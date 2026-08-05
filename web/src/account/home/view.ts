import type { PublicAccountConfig } from "../api";
import type { BillingOverview } from "../billing/types";
import type { CheckoutReturn } from "../billing/useBilling";
import type { AccountSession } from "../telegram/types";
import type {
  InstallationDeletion,
  InstallationUsage,
  ManagedInstallation,
} from "./types";

export type AccountRoute = "home" | "verify" | "recover";
export type AnonymousMode = "signup" | "login" | "recovery";

export type DashboardAction =
  | {
      kind: "create";
      handle: string;
      reservationKey: string;
      checkoutKey: string;
    }
  | { kind: "checkout"; installationId: string; idempotencyKey: string }
  | { kind: "portal"; installationId: string; idempotencyKey: string }
  | { kind: "provision"; installationId: string; enterAfter: boolean }
  | { kind: "enter"; installationId: string }
  | { kind: "export"; installationId: string }
  | {
      kind: "delete";
      installationId: string;
      confirmedHandle: string;
      idempotencyKey: string;
    }
  | { kind: "recover_deletion"; installationId: string };

export type DashboardView = {
  kind: "dashboard";
  session: AccountSession;
  config: PublicAccountConfig;
  installations: ManagedInstallation[];
  billing: BillingOverview | null;
  billingError?: string;
  deletions: Record<string, InstallationDeletion>;
  usage: Record<string, InstallationUsage>;
  checkoutReturn: CheckoutReturn;
  pending: {
    kind: DashboardAction["kind"];
    installationId?: string;
  } | null;
  notice?: string;
  error?: string;
};

export type AccountHomeView =
  | { kind: "loading"; title: string; copy: string }
  | {
      kind: "anonymous";
      mode: AnonymousMode;
      config: PublicAccountConfig;
      pending: boolean;
      resetKey: number;
      emailSent: boolean;
      error?: string;
    }
  | {
      kind: "enroll_passkey";
      session: AccountSession;
      pending: boolean;
      recovery: boolean;
      error?: string;
    }
  | {
      kind: "recovery_codes";
      session: AccountSession;
      codes: string[];
      pending: boolean;
      error?: string;
    }
  | {
      kind: "reauthentication";
      previous: DashboardView;
      config: PublicAccountConfig;
      pending: boolean;
      prompt: string;
      resetKey: number;
      error?: string;
    }
  | DashboardView
  | { kind: "failure"; title: string; message: string };
