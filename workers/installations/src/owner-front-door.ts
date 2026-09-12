import { InstallationOwnerAuthStore } from "./owner-auth-store";
import { InstallationOwnerEmailHttp } from "./owner-email-http";
import { InstallationOwnerHttp } from "./owner-http";
import { OwnerIdentityProvider } from "./owner-identity";
import { ownerEmailEnabled, type InstallationOwnerEnvironment } from "./owner-service";
import { InstallationOwnerStore } from "./owner-store";

/** Both public and commercial compositions use the same owner authentication boundary. */
export async function handleInstallationOwnerRequest(request: Request, env: InstallationOwnerEnvironment, registryPrincipalId: string): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const emailEnabled = ownerEmailEnabled(env);
  if (path !== "/owner" && !path.startsWith("/owner/") && !(emailEnabled && path === "/")) return null;
  if (!env.ACCOUNTS_GATEWAY_RECOVERY) return unavailable();
  const owners = new InstallationOwnerStore(env.INSTALLATIONS_DB, registryPrincipalId);
  if (emailEnabled && path !== "/owner/callback" && !path.startsWith("/owner/identity/")) {
    return new InstallationOwnerEmailHttp(new InstallationOwnerAuthStore(env.INSTALLATIONS_DB, env.GSV_OWNER_AUTH_SECRET!),
      owners, env.OWNER_EMAIL!, env.GSV_OWNER_EMAIL_FROM!, env.ACCOUNTS_GATEWAY_RECOVERY, env.GSV_ADMIN_ORIGIN,
      Boolean(env.GSV_OWNER_OIDC_ISSUER && env.GSV_OWNER_OIDC_CLIENT_ID)).handle(request);
  }
  if (env.GSV_OWNER_OIDC_ISSUER && env.GSV_OWNER_OIDC_CLIENT_ID) {
    return new InstallationOwnerHttp(owners, new OwnerIdentityProvider({ issuer: env.GSV_OWNER_OIDC_ISSUER,
      clientId: env.GSV_OWNER_OIDC_CLIENT_ID, clientSecret: env.GSV_OWNER_OIDC_CLIENT_SECRET, origin: env.GSV_ADMIN_ORIGIN }),
    env.ACCOUNTS_GATEWAY_RECOVERY, env.GSV_ADMIN_ORIGIN, emailEnabled ? "/owner/identity" : "/owner").handle(request);
  }
  return unavailable();
}

export async function cleanExpiredOwnerAuthentication(env: InstallationOwnerEnvironment): Promise<void> {
  if (ownerEmailEnabled(env)) await new InstallationOwnerAuthStore(env.INSTALLATIONS_DB, env.GSV_OWNER_AUTH_SECRET!).cleanup();
}

function unavailable(): Response {
  return new Response("Owner identity is not configured", { status: 503, headers: { "cache-control": "no-store" } });
}
