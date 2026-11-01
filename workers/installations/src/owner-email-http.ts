import type { InstallationRecoveryGatewayService } from "@humansandmachines/gsv/services/ownership";
import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import { escapeHtml as html } from "./admin/page";
import { hasExpectedOrigin, noStoreHeaders, readRequestBody } from "./http";
import { InstallationOwnerAuthStore, OwnerAuthError, type OwnerAuthErrorCode } from "./owner-auth-store";
import { InstallationOwnerStore, OwnerAttemptUnavailableError } from "./owner-store";
import { ownerPage, randomOwnerPageSecret as randomSecret } from "./owner-page";
import { sha256Hex } from "./tokens";
import { sendOwnerVerification } from "./owner-verification";
import type { OwnerEmailSender } from "./owner-verification-email";

type Purpose = "login" | "link" | "recover";
type ChallengeForm = { challengeId: string; purpose: Purpose; ownerAttemptId?: string; email: string };
const SESSION_COOKIE = "__Host-gsv-owner-session";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Longer than a normal send, so mailing the real owner takes no longer to answer than mailing nobody. */
const RECOVERY_RESPONSE_FLOOR_MS = 1500;

/** Accounts authenticates owners independently of any space or its messaging configuration. */
export class InstallationOwnerEmailHttp {
  constructor(private readonly auth: InstallationOwnerAuthStore, private readonly owners: InstallationOwnerStore,
    private readonly mail: SendEmail, private readonly sender: OwnerEmailSender,
    private readonly gateway: InstallationRecoveryGatewayService, private readonly origin: string,
    private readonly options: { existingIdentityProvider?: boolean; signup?: boolean; recoveryFloorMs?: number } = {}) {}

  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.pathname !== "/" && url.pathname !== "/owner" && !url.pathname.startsWith("/owner/")) return null;
    if (url.origin !== this.origin) return notFound();
    try {
      if (request.method === "GET") {
        if (["/", "/owner", "/owner/"].includes(url.pathname)) return redirect("/owner/spaces");
        if (url.pathname === "/owner/spaces") return await this.spaces(request);
        if (["/owner/login", "/owner/link", "/owner/recover"].includes(url.pathname)) return this.startPage(url);
      }
      if (request.method !== "POST") return notFound();
      if (!hasExpectedOrigin(request, this.origin)) return problem(403);
      if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/x-www-form-urlencoded") return problem(400);
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
      if (!["/owner/login", "/owner/link", "/owner/recover", "/owner/resend"].includes(url.pathname)) return notFound();
      const resend = url.pathname === "/owner/resend";
      if (!resend && url.pathname !== `/owner/${challenge.purpose}`) return problem(400);
      const ip = request.headers.get("cf-connecting-ip") ?? "local";
      if (challenge.purpose === "recover") return await this.sendRecoveryCode(challenge, form.get("handle") ?? "", browserSecret, ip, resend);
      if (!resend && challenge.purpose === "link") {
        if (!challenge.ownerAttemptId) return expired();
        await this.owners.startEmailAuthentication(challenge.ownerAttemptId, {
          browserSecretHash: await sha256Hex(browserSecret), linkSecretHash: await sha256Hex(form.get("secret") ?? ""),
        });
      }
      return await this.sendCode(challenge, browserSecret, ip, resend);
    } catch {
      return ownerPage(`<h1>That didn’t work</h1><p>This attempt may have expired or may have started in another browser. <a href="/owner/login">Sign in</a> to start again.</p>`, { status: 400 });
    }
  }

  private startPage(url: URL): Response {
    const purpose: Purpose = url.pathname === "/owner/link" ? "link" : url.pathname === "/owner/recover" ? "recover" : "login";
    const challengeId = crypto.randomUUID();
    const browserSecret = randomSecret();
    const title = purpose === "link" ? "Confirm your email" : purpose === "recover" ? "Forgot your password?" : "Sign in";
    const explanation = purpose === "link" ? "Confirm an email address so you can get back in if you lose your password."
      : purpose === "recover" ? "Enter your Ship’s handle and the email you signed up with. We’ll send a code, then you’ll set a new password on your Ship."
      : "Enter your email and we’ll send a code. Then we’ll take you to your Ship, where you sign in with your password.";
    const nonce = randomSecret();
    const handle = url.searchParams.get("handle") ?? "";
    const identityPath = `/owner/identity/${purpose}${purpose === "recover" && handle ? `?handle=${encodeURIComponent(handle)}` : ""}`;
    return ownerPage(`<h1>${title}</h1><p>${explanation}</p><form method="post" action="/owner/${purpose}">
      ${hidden("challengeId", challengeId)}${hidden("purpose", purpose)}
      ${purpose === "recover" ? `${hidden("ownerAttemptId", challengeId)}<label>Your Ship’s handle<input name="handle" value="${html(handle)}" required maxlength="63" autocapitalize="none" autocomplete="off" spellcheck="false"></label>` : ""}
      ${purpose === "link" ? `${hidden("ownerAttemptId", "")}${hidden("secret", "")}` : ""}
      <label>Email<input name="email" type="email" required maxlength="254" autocomplete="email" ${purpose === "recover" && !handle ? "" : "autofocus"}></label>
      <button>Send code</button></form>
      <nav>${purpose === "login" ? '<a href="/owner/recover">Forgot your password?</a>' : '<a href="/owner/login">Sign in instead</a>'}
      ${this.options.existingIdentityProvider && purpose !== "login" ? `<a id="existing-identity" href="${html(identityPath)}">Use your identity provider</a>` : ""}</nav>
      ${purpose === "link" ? `<script nonce="${nonce}">const p=new URLSearchParams(location.hash.slice(1));history.replaceState(null,"",location.pathname);document.querySelector('[name="ownerAttemptId"]').value=p.get("id")||"";document.querySelector('[name="secret"]').value=p.get("secret")||"";const identity=document.getElementById("existing-identity");if(identity)identity.hash=p.toString();</script>` : ""}`,
    { cookies: [setCookie(browserCookie(challengeId), browserSecret, 600), setCookie(pendingCookie(challengeId), randomSecret(), 600)], nonce });
  }

  /**
   * The same answer whether or not this email owns this handle, and whatever limit or delivery
   * problem applied: only the owner's inbox learns that the attempt was real.
   */
  private async sendRecoveryCode(challenge: ChallengeForm, handle: string, browserSecret: string, ip: string, resend: boolean): Promise<Response> {
    const answer = new Promise((resolve) => setTimeout(resolve, this.options.recoveryFloorMs ?? RECOVERY_RESPONSE_FLOOR_MS));
    try {
      if (!resend) {
        if (challenge.ownerAttemptId !== challenge.challengeId) throw new OwnerAttemptUnavailableError("Recovery attempt mismatch");
        await this.owners.beginRecovery(handle.trim().toLowerCase(), challenge.challengeId);
        await this.owners.startEmailAuthentication(challenge.challengeId, { browserSecretHash: await sha256Hex(browserSecret) });
      }
      const issued = await sendOwnerVerification(this.auth, this.mail, this.sender, { ...challenge, browserSecret, ip, resend });
      if (issued.deliveryStatus === "failed") console.warn("[Owner] Recovery code delivery failed");
    } catch (error) {
      if (!(error instanceof OwnerAuthError) && !(error instanceof OwnerAttemptUnavailableError)) console.warn("[Owner] Recovery request failed:", exceptionDiagnostics(error));
    }
    await answer;
    return recoveryCodePage(challenge, "If this is the email for this Ship, we’ve sent it a six-digit code. It can take a minute to arrive and expires after ten minutes.");
  }

  private async sendCode(challenge: ChallengeForm, browserSecret: string, ip: string, resend: boolean): Promise<Response> {
    try {
      const issued = await sendOwnerVerification(this.auth, this.mail, this.sender, { ...challenge, browserSecret, ip, resend });
      if (issued.deliveryStatus === "failed" && issued.attemptedDelivery) return codePage(challenge, "We could not send the code. Wait a minute, then try sending it again.", 503);
      if (issued.deliveryStatus !== "sent") return codePage(challenge, "Sending is still pending. Wait a minute before trying again.", 202);
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
      if (challenge.purpose === "login") {
        // Only this person's own directory rows choose the destination; signing in here opens no Ship.
        const reachable = (await this.owners.spaces(verified.principalId)).filter((space) => space.state === "active");
        return redirect(reachable.length === 1 ? new URL("/", reachable[0].canonicalOrigin).href : "/owner/spaces", [sessionCookie]);
      }
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
      if (challenge.purpose === "recover") {
        if (!(error instanceof OwnerAuthError)) console.warn("[Owner] Recovery verification failed:", exceptionDiagnostics(error));
        return recoveryCodePage(challenge, "That code didn’t work. Check it and try again, or start again for a new code.", 400);
      }
      return codePage(challenge, authErrorMessage(error instanceof OwnerAuthError ? error.code : "unavailable"), 400);
    }
  }

  private async spaces(request: Request): Promise<Response> {
    const token = cookie(request, SESSION_COOKIE);
    const session = token ? await this.auth.session(token) : null;
    if (!session) return redirect("/owner/login");
    const spaces = await this.owners.spaces(session.principalId);
    return ownerPage(`<h1>My Ships</h1><p class="quiet">${html(session.email)}</p>
      ${spaces.length ? `<ul class="ships">${spaces.map((space) => `<li><div>${space.state === "active"
        ? `<strong><a href="${html(space.canonicalOrigin)}">${html(space.handle)}</a></strong>` : `<strong>${html(space.handle)}</strong><small>Unavailable right now</small>`}</div>
        ${space.state === "active" ? `<a class="help" href="/owner/recover?handle=${encodeURIComponent(space.handle)}">Forgot your password?</a>` : ""}</li>`).join("")}</ul>`
        : `<p>No Ships for this email yet.${this.options.signup ? ' <a href="/owner/signup/">Create your Ship</a>.' : ""}</p><p class="quiet">Already have one under another address? Sign in with that email. If someone set up your Ship for you, sign in to it as administrator and confirm your email under Settings → Sign-in → Account recovery.</p>`}
      <nav><a href="/owner/recover">Forgot your password?</a><form method="post" action="/owner/logout"><button class="text">Sign out</button></form></nav>`);
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
    case "email_restricted": return "Use another email address to sign up.";
    default: return "Verification could not complete. Retry, or start again if this attempt has expired.";
  }
}
function recoveryCodePage(challenge: ChallengeForm, message: string, status = 200): Response {
  return codePage(challenge, message, status, `<p class="quiet">Nothing arrived? Check your spam folder and that you typed the address you signed up with. If email recovery isn’t set up for this Ship, use a messenger code on your Ship or ask whoever runs it.</p>`);
}
function codePage(challenge: ChallengeForm, message: string, status = 200, help = ""): Response {
  const fields = hidden("challengeId", challenge.challengeId) + hidden("purpose", challenge.purpose)
    + hidden("email", challenge.email) + (challenge.ownerAttemptId ? hidden("ownerAttemptId", challenge.ownerAttemptId) : "");
  return ownerPage(`<h1>Check your email</h1><p role="status">${html(message)}</p><p class="quiet">${html(challenge.email)}</p>
    <form method="post" action="/owner/verify">${fields}<label>Code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required autofocus></label><button>Confirm</button></form>
    ${help}<nav><form method="post" action="/owner/resend">${fields}<button class="text">Send again</button></form><a href="/owner/login">Start again</a></nav>`, { status });
}
function expired(): Response { return ownerPage('<h1>This code has expired</h1><p>Codes last ten minutes and only work in the browser that asked for them. <a href="/owner/login">Start again</a>.</p>', { status: 400 }); }
function notFound(): Response { return ownerPage('<h1>Page not found</h1><p><a href="/owner/login">Sign in to your Ship</a>.</p>', { status: 404 }); }
function problem(status: number): Response { return ownerPage('<h1>That didn’t work</h1><p>Open this page again and retry. <a href="/owner/login">Sign in to your Ship</a>.</p>', { status }); }
function hidden(name: string, value: string): string { return `<input type="hidden" name="${name}" value="${html(value)}">`; }
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
