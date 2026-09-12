import type { InstallationRecoveryGatewayService } from "@humansandmachines/gsv/services/ownership";
import { escapeHtml as html } from "./admin/page";
import { hasExpectedOrigin, noStoreHeaders, readRequestBody } from "./http";
import { InstallationOwnerAuthStore, OwnerAuthError, type OwnerAuthErrorCode } from "./owner-auth-store";
import { InstallationOwnerStore } from "./owner-store";
import { sha256Hex } from "./tokens";

type Purpose = "login" | "link" | "recover";
type ChallengeForm = { challengeId: string; purpose: Purpose; ownerAttemptId?: string; email: string };
const SESSION_COOKIE = "__Host-gsv-owner-session";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Accounts authenticates owners independently of any space or its messaging configuration. */
export class InstallationOwnerEmailHttp {
  constructor(private readonly auth: InstallationOwnerAuthStore, private readonly owners: InstallationOwnerStore,
    private readonly mail: SendEmail, private readonly from: string,
    private readonly gateway: InstallationRecoveryGatewayService, private readonly origin: string,
    private readonly existingIdentityProvider = false) {}

  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.pathname !== "/" && url.pathname !== "/owner" && !url.pathname.startsWith("/owner/")) return null;
    if (url.origin !== this.origin) return page("Not found", 404);
    try {
      if (request.method === "GET") {
        if (["/", "/owner", "/owner/"].includes(url.pathname)) return redirect("/owner/spaces");
        if (url.pathname === "/owner/spaces") return await this.spaces(request);
        if (["/owner/login", "/owner/link", "/owner/recover"].includes(url.pathname)) return this.startPage(url);
      }
      if (request.method !== "POST") return page("Not found", 404);
      if (!hasExpectedOrigin(request, this.origin)) return page("Request origin is not allowed", 403);
      if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/x-www-form-urlencoded") return page("Form is required", 400);
      const form = new URLSearchParams(new TextDecoder().decode(await readRequestBody(request, 4096)));
      if (url.pathname === "/owner/logout") {
        const session = cookie(request, SESSION_COOKIE);
        if (session) await this.auth.logout(session);
        return redirect("/owner/login", [setCookie(SESSION_COOKIE, "", 0)]);
      }
      const challenge = readChallenge(form);
      const browserSecret = cookie(request, browserCookie(challenge.challengeId));
      const sessionSecret = cookie(request, pendingCookie(challenge.challengeId));
      if (!browserSecret || !sessionSecret) return expired();
      if (url.pathname === "/owner/verify") return this.verify(challenge, form.get("code") ?? "", browserSecret, sessionSecret);
      if (["/owner/login", "/owner/link", "/owner/recover"].includes(url.pathname)) {
        if (url.pathname !== `/owner/${challenge.purpose}`) return page("Invalid verification purpose", 400);
        if (challenge.purpose !== "login") {
          if (!challenge.ownerAttemptId) return expired();
          if (challenge.purpose === "recover") {
            if (challenge.ownerAttemptId !== challenge.challengeId) return expired();
            await this.owners.beginRecovery(form.get("handle") ?? "", challenge.ownerAttemptId);
          }
          await this.owners.startEmailAuthentication(challenge.ownerAttemptId, {
            browserSecretHash: await sha256Hex(browserSecret), linkSecretHash: await sha256Hex(form.get("secret") ?? ""),
          });
        }
      } else if (url.pathname !== "/owner/resend") return page("Not found", 404);
      return await this.sendCode(challenge, browserSecret, request.headers.get("cf-connecting-ip") ?? "local", url.pathname === "/owner/resend");
    } catch {
      return page(`<h1>Verification unavailable</h1><p>This attempt may have expired or may not belong to this browser or owner. Start again from your space settings or <a href="/owner/login">sign in</a>.</p>`, 400);
    }
  }

  private startPage(url: URL): Response {
    const purpose: Purpose = url.pathname === "/owner/link" ? "link" : url.pathname === "/owner/recover" ? "recover" : "login";
    const challengeId = crypto.randomUUID();
    const browserSecret = randomSecret();
    const title = purpose === "link" ? "Link your space" : purpose === "recover" ? "Recover your space" : "Sign in";
    const explanation = purpose === "link" ? "Verify the email address you will use to recover this space."
      : purpose === "recover" ? "A new code sent to the verified owner is required to reset root."
      : "Enter your email to receive a sign-in code and see your spaces.";
    const nonce = randomSecret();
    return page(`<h1>${title}</h1><p>${explanation}</p><form method="post" action="/owner/${purpose}">
      ${hidden("challengeId", challengeId)}${hidden("purpose", purpose)}
      ${purpose === "recover" ? `${hidden("ownerAttemptId", challengeId)}<label>Space handle<input name="handle" value="${html(url.searchParams.get("handle") ?? "")}" required maxlength="63" autocomplete="off"></label>` : ""}
      ${purpose === "link" ? `${hidden("ownerAttemptId", "")}${hidden("secret", "")}` : ""}
      <label>Email<input name="email" type="email" required maxlength="254" autocomplete="email" autofocus></label>
      <button>Send code</button></form>
      <nav><a href="/owner/spaces">My spaces</a>${purpose !== "recover" ? '<a href="/owner/recover">Recover a space</a>' : ""}
      ${this.existingIdentityProvider && purpose !== "login" ? `<a id="existing-identity" href="/owner/identity/${purpose}">Use existing identity provider</a>` : ""}</nav>
      ${purpose === "link" ? `<script nonce="${nonce}">const p=new URLSearchParams(location.hash.slice(1));history.replaceState(null,"",location.pathname);document.querySelector('[name="ownerAttemptId"]').value=p.get("id")||"";document.querySelector('[name="secret"]').value=p.get("secret")||"";const identity=document.getElementById("existing-identity");if(identity)identity.hash=p.toString();</script>` : ""}`,
    200, [setCookie(browserCookie(challengeId), browserSecret, 600), setCookie(pendingCookie(challengeId), randomSecret(), 600)], nonce);
  }

  private async sendCode(challenge: ChallengeForm, browserSecret: string, ip: string, resend: boolean): Promise<Response> {
    try {
      const issued = await this.auth.issue({ ...challenge, browserSecret, ip, resend });
      if (issued.sendRequired && issued.deliveryId) {
        let sent = false;
        try {
          const purpose = challenge.purpose === "recover" ? "root recovery" : challenge.purpose === "link" ? "space ownership" : "sign-in";
          const text = `Your GSV ${purpose} code is ${issued.code}.\n\nThis code expires at ${new Date(issued.expiresAt).toUTCString()} and works only in the browser where you requested it. Do not share it.\n\nIf you did not request this code, you can ignore this email.`;
          await this.mail.send({ from: { email: this.from, name: "GSV" }, to: issued.email,
            subject: `Your GSV ${purpose} code`, text, html: `<p>${html(text).replaceAll("\n\n", "</p><p>").replaceAll("\n", "<br>")}</p>` });
          sent = true;
        } catch {
          // Delivery errors can contain addresses and mail bodies. Only expose the outcome.
        }
        await this.auth.recordDelivery({ challengeId: challenge.challengeId, deliveryId: issued.deliveryId, browserSecret, sent });
        if (!sent) return codePage(challenge, "We could not send the code. Wait a minute, then try sending it again.", 503);
      } else if (issued.deliveryStatus !== "sent") {
        return codePage(challenge, "Sending is still pending. Wait a minute before trying again.", 202);
      }
      return codePage(challenge, `Check your email for a six-digit code. It expires at ${new Date(issued.expiresAt).toUTCString()}.`);
    } catch (error) {
      const code = error instanceof OwnerAuthError ? error.code : "unavailable";
      return codePage(challenge, authErrorMessage(code), code === "rate_limited" ? 429 : 400);
    }
  }

  private async verify(challenge: ChallengeForm, code: string, browserSecret: string, sessionSecret: string): Promise<Response> {
    try {
      const verified = await this.auth.verify({ ...challenge, code, browserSecret, sessionSecret });
      const sessionCookie = setCookie(SESSION_COOKIE, sessionSecret, Math.max(0, Math.floor((verified.sessionExpiresAt - Date.now()) / 1000)));
      if (challenge.purpose === "login") return redirect("/owner/spaces", [sessionCookie]);
      const receipt = await this.auth.receipt({ receiptId: verified.receiptId, browserSecret, purpose: challenge.purpose, ownerAttemptId: challenge.ownerAttemptId });
      if (!receipt || !challenge.ownerAttemptId) return expired();
      const hash = await sha256Hex(browserSecret);
      const attempt = await this.owners.verifyPrincipal(challenge.ownerAttemptId, hash, verified.principalId);
      if (challenge.purpose === "link") {
        if (attempt.state !== "complete") await this.gateway.confirmOwnerLinkAuthorization({ installationId: attempt.installation_id, attemptId: attempt.id });
        await this.owners.completeLink(attempt.id, hash);
      }
      const destination = await this.owners.destination(attempt);
      const location = new URL(challenge.purpose === "link" ? "/?owner=linked" : "/recover", destination.canonicalOrigin);
      if (challenge.purpose === "recover") {
        await this.gateway.authorizeRootRecovery({ installationId: destination.installationId, attemptId: attempt.id,
          purpose: "root-password-reset", secretHash: hash, expiresAt: attempt.expires_at });
        location.hash = new URLSearchParams({ id: attempt.id, secret: browserSecret }).toString();
      }
      return redirect(location.href, [sessionCookie]);
    } catch (error) {
      return codePage(challenge, authErrorMessage(error instanceof OwnerAuthError ? error.code : "unavailable"), 400);
    }
  }

  private async spaces(request: Request): Promise<Response> {
    const token = cookie(request, SESSION_COOKIE);
    const session = token ? await this.auth.session(token) : null;
    if (!session) return redirect("/owner/login");
    const spaces = await this.owners.spaces(session.principalId);
    return page(`<h1>My spaces</h1><p>${html(session.email)}</p>
      ${spaces.length ? `<ul class="spaces">${spaces.map(space => `<li><div>${space.state === "active"
        ? `<a href="${html(space.canonicalOrigin)}">${html(space.handle)}</a>` : html(space.handle)}<small>${html(space.state)}</small></div>
        ${space.state === "active" ? `<a class="secondary" href="/owner/recover?handle=${encodeURIComponent(space.handle)}">Recover root</a>` : ""}</li>`).join("")}</ul>`
        : "<p>No spaces linked yet. Open a space you own and link your email in Settings. Your operator can provide a setup invitation for a new space.</p>"}
      <nav><a href="/owner/recover">Recover a space</a><form method="post" action="/owner/logout"><button class="text">Sign out</button></form></nav>`);
  }
}

function readChallenge(form: URLSearchParams): ChallengeForm {
  const challengeId = form.get("challengeId") ?? "";
  const purpose = form.get("purpose");
  const ownerAttemptId = form.get("ownerAttemptId") || undefined;
  if (!UUID.test(challengeId) || (purpose !== "login" && purpose !== "link" && purpose !== "recover")
    || (purpose === "login" ? ownerAttemptId !== undefined : !ownerAttemptId || !UUID.test(ownerAttemptId))) throw new Error("Invalid challenge");
  return { challengeId, purpose, ownerAttemptId, email: form.get("email") ?? "" };
}
function authErrorMessage(code: OwnerAuthErrorCode): string {
  switch (code) {
    case "invalid": return "The code is incorrect. Check it and try again.";
    case "expired": return "This code has expired. Start again for a new code.";
    case "locked": return "Too many incorrect attempts. Start again for a new code.";
    case "rate_limited": return "Too many requests. Wait before requesting another code.";
    case "credential_unavailable": return "This email uses another sign-in method. Continue with your existing identity provider.";
    default: return "Verification could not complete. Retry, or start again if this attempt has expired.";
  }
}
function codePage(challenge: ChallengeForm, message: string, status = 200): Response {
  const fields = hidden("challengeId", challenge.challengeId) + hidden("purpose", challenge.purpose)
    + hidden("email", challenge.email) + (challenge.ownerAttemptId ? hidden("ownerAttemptId", challenge.ownerAttemptId) : "");
  return page(`<h1>Check your email</h1><p role="status">${html(message)}</p><p>${html(challenge.email)}</p>
    <form method="post" action="/owner/verify">${fields}<label>Code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required autofocus></label><button>Verify code</button></form>
    <nav><form method="post" action="/owner/resend">${fields}<button class="text">Send again</button></form><a href="/owner/login">Start again</a></nav>`, status);
}
function expired(): Response { return page('<h1>Verification expired</h1><p>Start again in this browser from <a href="/owner/login">sign-in</a> or your space settings.</p>', 400); }
function hidden(name: string, value: string): string { return `<input type="hidden" name="${name}" value="${html(value)}">`; }
function randomSecret(): string { return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join(""); }
function pendingCookie(id: string): string { return `__Host-gsv-owner-pending-${id}`; }
function browserCookie(id: string): string { return `__Host-gsv-owner-browser-${id}`; }
function cookie(request: Request, name: string): string | undefined {
  const value = request.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}
function setCookie(name: string, value: string, age: number): string { return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`; }
function redirect(location: string, cookies: string[] = []): Response {
  const headers = noStoreHeaders({ location });
  for (const value of cookies) headers.append("set-cookie", value);
  return new Response(null, { status: 303, headers });
}
function page(content: string, status = 200, cookies: string[] = [], nonce = randomSecret()): Response {
  const headers = noStoreHeaders({ "content-type": "text/html; charset=utf-8", "content-security-policy":
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'` });
  for (const value of cookies) headers.append("set-cookie", value);
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light"><title>GSV · My spaces</title>
    <style nonce="${nonce}">:root{color-scheme:dark;--bg:#111210;--fg:#dedfd6;--muted:#999d90;--line:#36382f;--accent:#d2e89b}@media(prefers-color-scheme:light){:root{color-scheme:light;--bg:#f4f2eb;--fg:#25271f;--muted:#696d5d;--line:#d6d5c9;--accent:#536d28}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}header{padding:24px 32px;border-bottom:1px solid var(--line)}header a{font-weight:600;letter-spacing:.16em;text-decoration:none}main{max-width:580px;margin:12vh auto;padding:0 24px 48px}h1{font-size:26px;font-weight:600;letter-spacing:-.04em}p{color:var(--muted);overflow-wrap:anywhere}a{color:var(--accent);text-underline-offset:4px}label{display:block;margin:20px 0}input{display:block;width:100%;margin-top:8px;border:1px solid var(--line);background:transparent;color:inherit;font:inherit;padding:12px}input:focus-visible,button:focus-visible,a:focus-visible{outline:1px solid var(--accent);outline-offset:3px}button{border:1px solid var(--line);background:transparent;color:var(--accent);font:inherit;padding:10px 18px;cursor:pointer}.text{padding:0;border:0;text-decoration:underline;text-underline-offset:4px}nav{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:20px;margin-top:32px}.spaces{list-style:none;padding:0}.spaces li{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:20px 0;border-bottom:1px solid var(--line)}small{display:block;color:var(--muted)}.spaces li>div{min-width:0;overflow-wrap:anywhere}.secondary{font-size:12px;flex-shrink:0}::selection{background:var(--accent);color:var(--bg)}</style></head>
    <body><header><a href="/owner/spaces">GSV</a></header><main>${content}</main></body></html>`, { status, headers });
}
