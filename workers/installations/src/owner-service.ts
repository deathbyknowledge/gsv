import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  BeginInstallationOwnerLinkInput, InstallationOwnershipService, InstallationRecoveryGatewayService, OwnerSignInCodeInput,
  OwnerSignInVerification, OwnerSignInVerifyInput,
} from "@humansandmachines/gsv/services/ownership";
import { z } from "zod";
import { InstallationOwnerAuthStore, OwnerAuthError } from "./owner-auth-store";
import { InstallationOwnerRecovery } from "./owner-recovery";
import { InstallationOwnerStore } from "./owner-store";
import type { ProductEmailEnvironment } from "./product-email";

export const OPERATOR_REGISTRY_PRINCIPAL_ID = "principal_operator_registry";
export type InstallationOwnerEnvironment = ProductEmailEnvironment & {
  GSV_SIGNUP_ENABLED?: string;
  INSTALLATIONS_DB: D1Database;
  GSV_ADMIN_ORIGIN: string;
  GSV_BASE_DOMAIN: string;
  GSV_DOMAIN_ALIASES?: string;
  GSV_PUBLIC_CONFIG?: string;
  GSV_OWNER_ORIGIN_ALIASES?: string;
  GSV_OWNER_OIDC_ISSUER?: string;
  GSV_OWNER_OIDC_CLIENT_ID?: string;
  ACCOUNTS_GATEWAY_RECOVERY?: InstallationRecoveryGatewayService;
  GSV_OWNER_OIDC_CLIENT_SECRET?: string;
  OWNER_EMAIL?: SendEmail;
  GSV_OWNER_EMAIL_FROM?: string;
  GSV_OWNER_EMAIL_REPLY_TO?: string;
  GSV_OWNER_AUTH_SECRET?: string;
  GSV_OWNER_SIGNUP_ORIGIN?: string;
  GSV_OWNER_SIGNUP_ORIGIN_ALIASES?: string;
  ASSETS?: Fetcher;
};

export function ownerEmailEnabled(env: InstallationOwnerEnvironment): boolean {
  return Boolean(env.OWNER_EMAIL && env.GSV_OWNER_EMAIL_FROM && env.GSV_OWNER_AUTH_SECRET);
}

export function ownerIdentityEnabled(env: InstallationOwnerEnvironment): boolean {
  return Boolean(env.ACCOUNTS_GATEWAY_RECOVERY && (ownerEmailEnabled(env) || (env.GSV_OWNER_OIDC_ISSUER && env.GSV_OWNER_OIDC_CLIENT_ID)));
}

const signInAttempt = z.object({ installationId: z.string().min(1).max(128), attemptId: z.uuid(), secret: z.string().regex(/^[a-f0-9]{64}$/) });
const signInCode = signInAttempt.extend({ email: z.string().max(254), source: z.string().min(1).max(96), resend: z.boolean().optional() });
const signInVerify = signInAttempt.extend({ code: z.string().regex(/^\d{6}$/) });

/**
 * Email sign-in for the Kernel that asks, for its own installation only. It is owner recovery whose claim the Kernel
 * spends on a session, so it needs the owner's current email and nothing a recovery would not.
 */
export class InstallationOwnerSignIn {
  constructor(private readonly auth: InstallationOwnerAuthStore, private readonly recovery: InstallationOwnerRecovery) {}

  async sendOwnerSignInCode(input: OwnerSignInCodeInput): Promise<{ accepted: true }> {
    const args = signInCode.parse(input);
    await this.recovery.sendCode({ ship: { installationId: args.installationId }, attemptId: args.attemptId, browserSecret: args.secret,
      email: args.email, ip: `kernel:${args.source}`, resend: args.resend ?? false, signIn: true });
    return { accepted: true };
  }

  async verifyOwnerSignIn(input: OwnerSignInVerifyInput): Promise<OwnerSignInVerification> {
    const args = signInVerify.parse(input);
    try {
      const { claim } = await this.recovery.verify({ attemptId: args.attemptId, browserSecret: args.secret,
        sessionSecret: await this.auth.unheldSessionSecret(args.attemptId, args.secret), code: args.code });
      return claim.installationId === args.installationId ? { authorized: claim } : { failed: "unavailable" };
    } catch (error) {
      // Anything but a refusal reaches the Kernel, which records it and answers with its reference.
      if (!(error instanceof OwnerAuthError)) throw error;
      return { failed: error.code === "invalid" || error.code === "expired" || error.code === "locked" ? error.code : "unavailable" };
    }
  }
}

export class InstallationOwnerLinkService implements Pick<InstallationOwnershipService, "beginInstallationOwnerLink"> {
  constructor(private readonly store: InstallationOwnerStore, private readonly origin: string,
    authority: { authority?: string } | undefined, enabled: boolean) {
    if (authority?.authority !== "kernel-owner-link" || !enabled) throw new Error("Owner linking authority is not configured");
  }

  async beginInstallationOwnerLink(input: BeginInstallationOwnerLinkInput): Promise<{ url: string; expiresAt: number }> {
    if (!/^[a-f0-9-]{36}$/.test(input.attemptId)) throw new Error("Invalid owner link attempt");
    const attempt = await this.store.beginLink(input);
    return { url: `${this.origin}/owner/link`, expiresAt: attempt.expires_at };
  }
}

/** Only the Kernel's deployment-granted binding may attest a root-owned link attempt or ask for its owner's sign-in. */
export class InstallationOwnershipEntrypoint extends WorkerEntrypoint<InstallationOwnerEnvironment, { authority: "kernel-owner-link" }>
  implements InstallationOwnershipService {
  async beginInstallationOwnerLink(input: BeginInstallationOwnerLinkInput): Promise<{ url: string; expiresAt: number }> {
    return new InstallationOwnerLinkService(new InstallationOwnerStore(this.env.INSTALLATIONS_DB, OPERATOR_REGISTRY_PRINCIPAL_ID),
      this.env.GSV_ADMIN_ORIGIN, this.ctx.props, ownerIdentityEnabled(this.env))
      .beginInstallationOwnerLink(input);
  }

  async sendOwnerSignInCode(input: OwnerSignInCodeInput): Promise<{ accepted: true }> {
    return this.signIn().sendOwnerSignInCode(input);
  }

  async verifyOwnerSignIn(input: OwnerSignInVerifyInput): Promise<OwnerSignInVerification> {
    return this.signIn().verifyOwnerSignIn(input);
  }

  private signIn(): InstallationOwnerSignIn {
    if (this.ctx.props?.authority !== "kernel-owner-link" || !ownerEmailEnabled(this.env)) throw new Error("Owner email sign-in is not configured");
    const auth = new InstallationOwnerAuthStore(this.env.INSTALLATIONS_DB, this.env.GSV_OWNER_AUTH_SECRET!);
    return new InstallationOwnerSignIn(auth, new InstallationOwnerRecovery(auth,
      new InstallationOwnerStore(this.env.INSTALLATIONS_DB, OPERATOR_REGISTRY_PRINCIPAL_ID),
      this.env.OWNER_EMAIL!, { from: this.env.GSV_OWNER_EMAIL_FROM!, replyTo: this.env.GSV_OWNER_EMAIL_REPLY_TO }));
  }
}
