import AccountService, {
  EntitlementReaderEntrypoint,
  GatewayDirectoryEntrypoint,
  parseAccountOrigin,
  type AccountServiceEnv,
} from "./index";
import { ACCOUNT_SESSION_COOKIE } from "./auth/session-cookie";
import { PlatformAuthStore } from "./auth/store";
import { EntitlementStore } from "./entitlements/store";
import { GatewayEntitlementProjector } from "./entitlements/projector";
import { hasExpectedOrigin, noStoreHeaders } from "./http";
import { provisionReservedInstallation } from "./provisioning";
import { AccountStore, type InstallationReservation } from "./store";

export { EntitlementReaderEntrypoint, GatewayDirectoryEntrypoint };

const DEVELOPMENT_PATH = "/__gsv/development";
const DEVELOPMENT_BOOTSTRAP_PATH = `${DEVELOPMENT_PATH}/bootstrap`;
const DEVELOPMENT_PRINCIPAL_ID = "principal_local_development";
const DEVELOPMENT_EMAIL = "reviewer@gsv.invalid";
const DEVELOPMENT_OPERATION_ID = "operation_local_development_v1";
const DEVELOPMENT_HANDLE = "local";
const DEVELOPMENT_USERNAME = "owner";
const DEVELOPMENT_AGENT_NAME = "gsv";
const DEVELOPMENT_PLAN_KEY = "local-development";
const DEVELOPMENT_PERIOD_MS = 30 * 24 * 60 * 60_000;

const LOCAL_ACCOUNT_SESSION_COOKIE = "gsv-local-account-session";

type DevelopmentBoundaryEnv = {
  ENVIRONMENT: string;
  GSV_ACCOUNT_ORIGIN: string;
  GSV_BASE_DOMAIN: string;
  GSV_INSTALLATION_ORIGIN_TEMPLATE?: string;
};

type DevelopmentBootstrap = {
  action: string;
  token: string;
};

/**
 * Local-only account surface and managed-installation bootstrap.
 *
 * The production account entrypoint never imports this module. Its Wrangler
 * config has no routes and is used only by scripts/dev-managed-stack.sh.
 */
export default class DevelopmentAccountService extends AccountService {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let accountOrigin: string;
    try {
      accountOrigin = developmentAccountOrigin(this.env);
    } catch {
      return new Response("Not Found", { status: 404 });
    }
    if (url.origin !== accountOrigin) {
      return new Response("Not Found", { status: 404 });
    }
    if (url.pathname === DEVELOPMENT_PATH && request.method === "GET") {
      return developmentLandingPage();
    }
    if (
      url.pathname === DEVELOPMENT_BOOTSTRAP_PATH
      && request.method === "POST"
    ) {
      if (!hasExpectedOrigin(request, accountOrigin)) {
        return new Response("Forbidden", { status: 403 });
      }
      try {
        return developmentHandoffPage(await this.bootstrap());
      } catch {
        console.error("[ManagedDevelopment] Local bootstrap failed");
        return new Response(
          "Local managed bootstrap failed. Restart with a clean GSV_MANAGED_DEV_STATE_DIR if the persisted state is stale.",
          { status: 503, headers: noStoreHeaders() },
        );
      }
    }

    const normalized = withDevelopmentCookie(
      request,
      LOCAL_ACCOUNT_SESSION_COOKIE,
      ACCOUNT_SESSION_COOKIE,
    );
    return withDevelopmentSetCookie(
      await super.fetch(normalized),
      ACCOUNT_SESSION_COOKIE,
      LOCAL_ACCOUNT_SESSION_COOKIE,
    );
  }

  private async bootstrap(): Promise<DevelopmentBootstrap> {
    const accounts = new AccountStore(
      this.env.ACCOUNT_DB,
      this.env.GSV_BASE_DOMAIN,
      this.env.GSV_INSTALLATION_ORIGIN_TEMPLATE,
    );
    const auth = new PlatformAuthStore(this.env.ACCOUNT_DB);
    let principal = await auth.getPrincipalByEmail(DEVELOPMENT_EMAIL);
    if (!principal) {
      await accounts.createPrincipal({
        principalId: DEVELOPMENT_PRINCIPAL_ID,
        email: DEVELOPMENT_EMAIL,
        displayName: "Local reviewer",
        verified: true,
      });
      principal = await auth.getPrincipal(DEVELOPMENT_PRINCIPAL_ID);
    }
    if (
      !principal
      || principal.state !== "active"
      || principal.emailVerifiedAt === null
    ) {
      throw new Error("local development principal is unavailable");
    }

    let installation = await accounts.getReservationByOperation(
      DEVELOPMENT_OPERATION_ID,
    );
    if (!installation) {
      installation = await accounts.reserveInstallation({
        principalId: principal.id,
        operationId: DEVELOPMENT_OPERATION_ID,
        handle: DEVELOPMENT_HANDLE,
        ownerUsername: DEVELOPMENT_USERNAME,
        agentName: DEVELOPMENT_AGENT_NAME,
        timezone: "UTC",
      });
    }
    assertDevelopmentReservation(installation, principal.id);

    const entitlements = new EntitlementStore(this.env.ACCOUNT_DB);
    const currentEntitlement = await entitlements.get(installation.installationId);
    const now = Date.now();
    if (
      !currentEntitlement
      || currentEntitlement.state !== "trialing"
      || currentEntitlement.inferencePeriodEndsAt <= now
    ) {
      await new GatewayEntitlementProjector(
        entitlements,
        this.env.GATEWAY,
      ).project({
        installationId: installation.installationId,
        state: "trialing",
        planKey: DEVELOPMENT_PLAN_KEY,
        inferenceBudgetMicrounits: 5_000_000,
        inferencePeriodStartsAt: now,
        inferencePeriodEndsAt: now + DEVELOPMENT_PERIOD_MS,
        storageLimitBytes: 10 * 1024 * 1024 * 1024,
        effectiveAt: now,
        version: (currentEntitlement?.version ?? 0) + 1,
      });
    }

    if (installation.operationState !== "complete") {
      installation = await provisionReservedInstallation(
        accounts,
        this.env.GATEWAY,
        {
          operationId: installation.operationId,
          principalId: principal.id,
          username: DEVELOPMENT_USERNAME,
          agentName: DEVELOPMENT_AGENT_NAME,
          timezone: "UTC",
        },
      );
    }
    const handoff = await auth.createLoginHandoff({
      principalId: principal.id,
      installationId: installation.installationId,
    });
    return {
      action: new URL("/auth/handoff", handoff.canonicalOrigin).toString(),
      token: handoff.token,
    };
  }
}

export function developmentAccountOrigin(
  env: DevelopmentBoundaryEnv,
): string {
  const accountOrigin = parseAccountOrigin(env.GSV_ACCOUNT_ORIGIN);
  const accountUrl = new URL(accountOrigin);
  const port = accountUrl.port ? `:${accountUrl.port}` : "";
  if (
    env.ENVIRONMENT !== "test"
    || accountUrl.hostname !== "localhost"
    || env.GSV_BASE_DOMAIN !== "localhost"
    || env.GSV_INSTALLATION_ORIGIN_TEMPLATE
      !== `${accountUrl.protocol}//{handle}.localhost${port}`
  ) {
    throw new Error("managed development environment is invalid");
  }
  return accountOrigin;
}

function assertDevelopmentReservation(
  reservation: InstallationReservation,
  principalId: string,
): void {
  if (
    reservation.ownerPrincipalId !== principalId
    || reservation.handle !== DEVELOPMENT_HANDLE
    || reservation.ownerUsername !== DEVELOPMENT_USERNAME
    || reservation.agentName !== DEVELOPMENT_AGENT_NAME
  ) {
    throw new Error("local development reservation conflicts with persisted state");
  }
}

export function withDevelopmentCookie(
  request: Request,
  localName: string,
  productionName: string,
): Request {
  const cookie = request.headers.get("cookie");
  if (!cookie) return request;
  const parts = cookie.split(";").map((part) => part.trim());
  const local = parts.find((part) => cookieName(part) === localName);
  if (!local) return request;
  const value = local.slice(local.indexOf("=") + 1).trim();
  const rewritten = parts
    .filter((part) => {
      const name = cookieName(part);
      return name !== localName && name !== productionName;
    })
    .concat(`${productionName}=${value}`)
    .join("; ");
  const headers = new Headers(request.headers);
  headers.set("cookie", rewritten);
  return new Request(request, { headers });
}

export function withDevelopmentSetCookie(
  response: Response,
  productionName: string,
  localName: string,
): Response {
  const cookie = response.headers.get("set-cookie");
  if (!cookie?.startsWith(`${productionName}=`)) return response;
  const headers = new Headers(response.headers);
  headers.set(
    "set-cookie",
    `${localName}=${cookie.slice(productionName.length + 1)}`
      .replace(/;\s*Secure(?=;|$)/gi, ""),
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function cookieName(part: string): string {
  const separator = part.indexOf("=");
  return separator === -1 ? "" : part.slice(0, separator).trim();
}

function developmentLandingPage(): Response {
  return html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Opening local GSV</title>
  </head>
  <body>
    <main>
      <h1>Opening your local managed GSV…</h1>
      <p>This creates or resumes a local trial using the real managed provisioning path.</p>
      <form method="post" action="${DEVELOPMENT_BOOTSTRAP_PATH}">
        <button type="submit">Open local GSV</button>
      </form>
    </main>
  </body>
</html>`, "form-action 'self'");
}

function developmentHandoffPage(handoff: DevelopmentBootstrap): Response {
  const action = escapeHtml(handoff.action);
  const token = escapeHtml(handoff.token);
  return html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="referrer" content="no-referrer">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Signing in to local GSV</title>
  </head>
  <body>
    <main>
      <h1>Signing in to your local GSV…</h1>
      <form method="post" action="${action}">
        <input type="hidden" name="token" value="${token}">
        <button type="submit">Continue</button>
      </form>
    </main>
    <script>document.querySelector("form").requestSubmit();</script>
  </body>
</html>`, `form-action ${new URL(handoff.action).origin}`, true);
}

function html(
  body: string,
  formAction: string,
  allowInlineScript = false,
): Response {
  const policy = [
    "default-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    formAction,
    "style-src 'unsafe-inline'",
  ];
  if (allowInlineScript) policy.push("script-src 'unsafe-inline'");
  return new Response(body, {
    headers: noStoreHeaders({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": policy.join("; "),
    }),
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
