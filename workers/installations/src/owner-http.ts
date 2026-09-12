import * as oauth from "oauth4webapi";
import type { InstallationRecoveryGatewayService } from "@humansandmachines/gsv/services/ownership";
import { hasExpectedOrigin, noStoreHeaders, readRequestBody } from "./http";
import { escapeHtml } from "./admin/page";
import { InstallationOwnerStore, type OwnerAttempt } from "./owner-store";
import { OwnerIdentityProvider } from "./owner-identity";
import { sha256Hex } from "./tokens";

/** Small public identity front door; all authority comes from verified attempts and Kernel receipts. */
export class InstallationOwnerHttp {
  constructor(private readonly store: InstallationOwnerStore, private readonly identity: OwnerIdentityProvider,
    private readonly gateway: InstallationRecoveryGatewayService, private readonly origin: string, private readonly prefix = "/owner") {}

  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/owner/")) return null;
    if (url.origin !== this.origin) return page("Not found", 404);
    const path = url.pathname.startsWith(`${this.prefix}/`) ? `/owner/${url.pathname.slice(this.prefix.length + 1)}` : url.pathname;
    try {
      if (request.method === "GET" && path === "/owner/recover") {
        return page(`<h1>Recover your GSV</h1><p>Sign in as the verified owner to reset the root password for your space.</p>
          <form method="post" action="${this.prefix}/recover"><label>Space handle <input name="handle" required maxlength="63" autocomplete="off"></label><button>Verify owner</button></form>`);
      }
      if (request.method === "GET" && path === "/owner/link") {
        return page(`<h1>Link the owner of your GSV</h1><p>Continue to verify the identity that can recover root for this space.</p>
          <form method="post" action="${this.prefix}/link"><input type="hidden" name="id"><input type="hidden" name="secret"><button>Verify owner</button></form>
          <script>const p=new URLSearchParams(location.hash.slice(1));history.replaceState(null,"",location.pathname);document.querySelector('[name="id"]').value=p.get("id")||"";document.querySelector('[name="secret"]').value=p.get("secret")||"";</script>`);
      }
      if (request.method === "POST" && (path === "/owner/link" || path === "/owner/recover")) {
        if (!hasExpectedOrigin(request, this.origin)) return page("Request origin is not allowed", 403);
        if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/x-www-form-urlencoded") return page("Form is required", 400);
        const form = new URLSearchParams(new TextDecoder().decode(await readRequestBody(request, 4096)));
        const id = path === "/owner/link" ? form.get("id") ?? "" : crypto.randomUUID();
        if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid attempt");
        if (path === "/owner/recover") await this.store.beginRecovery(form.get("handle") ?? "", id);
        const browserSecret = oauth.generateRandomState();
        const attempt = await this.store.startAuthentication(id, {
          linkSecretHash: await sha256Hex(form.get("secret") ?? ""), browserSecretHash: await sha256Hex(browserSecret),
          verifier: oauth.generateRandomCodeVerifier(), nonce: oauth.generateRandomNonce(),
        });
        const location = await this.identity.authorizationUrl(attempt);
        return new Response(null, { status: 303, headers: noStoreHeaders({ location,
          "set-cookie": `${cookieName(id)}=${browserSecret}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600` }) });
      }
      if (request.method === "GET" && path === "/owner/callback") {
        const id = url.searchParams.get("state") ?? "";
        if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid attempt");
        const secret = readCookie(request, cookieName(id));
        if (!secret) throw new Error("Authentication browser is unavailable");
        const hash = await sha256Hex(secret);
        let attempt = await this.store.get(id);
        if (!attempt || attempt.browser_secret_hash !== hash || attempt.expires_at <= Date.now()) throw new Error("Authentication attempt is unavailable");
        if (attempt.state === "authenticating") {
          attempt = await this.store.verify(id, hash, await this.identity.complete(url, attempt));
        }
        if (attempt.state !== "verified" && attempt.state !== "complete") throw new Error("Authentication attempt is unavailable");
        return await this.finish(attempt, secret);
      }
      return page("Not found", 404);
    } catch {
      // Provider exceptions may carry authorization codes or token bodies. Never render or log them.
      return page(`<h1>Owner verification could not complete</h1><p>The attempt may have expired or the identity may not own this space. Start again from your GSV settings or <a href="/owner/recover">owner recovery</a>.</p>`, 400);
    }
  }

  private async finish(attempt: OwnerAttempt, secret: string): Promise<Response> {
    if (attempt.purpose === "link") {
      if (attempt.state !== "complete") await this.gateway.confirmOwnerLinkAuthorization({ installationId: attempt.installation_id, attemptId: attempt.id });
      await this.store.completeLink(attempt.id, attempt.browser_secret_hash!);
    }
    const destination = await this.store.destination(attempt);
    const redirect = new URL(attempt.purpose === "link" ? "/?owner=linked" : "/recover", destination.canonicalOrigin);
    if (attempt.purpose === "recover") {
      await this.gateway.authorizeRootRecovery({ installationId: destination.installationId, attemptId: attempt.id,
        purpose: "root-password-reset", secretHash: attempt.browser_secret_hash!, expiresAt: attempt.expires_at });
      redirect.hash = new URLSearchParams({ id: attempt.id, secret }).toString();
    }
    return new Response(null, { status: 303, headers: noStoreHeaders({ location: redirect.href }) });
  }
}

function cookieName(id: string): string { return `__Host-gsv-owner-${id}`; }
function readCookie(request: Request, name: string): string | undefined {
  return request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}
function page(content: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml("Your GSV · owner access")}</title><main>${content}</main></html>`,
    { status, headers: noStoreHeaders({ "content-type": "text/html; charset=utf-8" }) });
}
