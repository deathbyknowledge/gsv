import type { InstallationAdminAccess } from "./admin/access";
import { adminPageResponse, adminStylesheet } from "./admin/page";
import { InstallationBootstrapService, type OperatorAccessMode } from "./bootstrap";
import { hasExpectedOrigin, json, noStoreHeaders, readJsonObject, requireString } from "./http";

const COOKIE = "gsv_operator";

export class OperatorInstallationAdminAccess implements InstallationAdminAccess {
  constructor(private readonly bootstrap: InstallationBootstrapService, private readonly mode: OperatorAccessMode,
    private readonly access: InstallationAdminAccess) {}

  async allows(request: Request): Promise<boolean> {
    if (this.mode === "access") return this.access.allows(request);
    const bearer = /^Bearer (operator_[A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const cookie = request.headers.get("cookie")?.split(";").map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    return this.bootstrap.authorizeOperator(bearer ?? cookie ?? "");
  }
}

export class InstallationOperatorHttp {
  constructor(private readonly bootstrap: InstallationBootstrapService, private readonly origin: string,
    private readonly mode: OperatorAccessMode) {}

  async handle(request: Request): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    if (path === "/admin/styles.css" && request.method === "GET") return adminStylesheet(false);
    if (path === "/operator/client.js" && request.method === "GET") {
      return new Response(OPERATOR_CLIENT, { headers: noStoreHeaders({ "content-type": "text/javascript; charset=utf-8" }) });
    }
    if (!["/bootstrap", "/operator", "/operator/login", "/operator/logout"].includes(path)) return null;
    if (new URL(request.url).origin !== this.origin) return json({ error: "Forbidden" }, 403);
    if (request.method === "GET" && (path === "/bootstrap" || path === "/operator")) return this.page(path === "/bootstrap");
    if (request.method !== "POST") return json({ error: "Not Found" }, 404);
    if (!hasExpectedOrigin(request, this.origin)) return json({ error: "Forbidden" }, 403);
    if (path === "/operator/logout") {
      return jsonWithCookie({ signedOut: true }, `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
    }
    try {
      const body = await readJsonObject(request);
      if (path === "/operator/login") {
        const token = requireString(body.token, "token");
        if (!await this.bootstrap.authorizeOperator(token)) return json({ error: "Operator credential is unavailable." }, 403);
        return jsonWithCookie({ signedIn: true }, operatorCookie(token));
      }
      if (path !== "/bootstrap") return json({ error: "Not Found" }, 404);
      const input: Parameters<InstallationBootstrapService["redeem"]>[0] = {
        claim: requireString(body.claim, "claim"), handle: requireString(body.handle, "handle"),
        onboardingToken: requireString(body.onboardingToken, "onboardingToken"),
      };
      if (body.operatorToken !== undefined) input.operatorToken = requireString(body.operatorToken, "operatorToken");
      const result = await this.bootstrap.redeem(input);
      const response = json(result);
      if (result.operatorAccess && input.operatorToken) response.headers.set("set-cookie", operatorCookie(input.operatorToken));
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (["bootstrap ", "handle ", "request ", "JSON "].some((prefix) => message.startsWith(prefix))) {
        return json({ error: message }, 400);
      }
      return json({ error: "The operator request could not be completed. Retry the same attempt." }, 503);
    }
  }

  private page(bootstrap: boolean): Response {
    const response = adminPageResponse({ title: bootstrap ? "Create your first space" : "Operator access", section: "operator", content: `
      <section class="narrow stack" data-bootstrap="${bootstrap}" data-mode="${this.mode}">
        <div class="page-heading"><h1>${bootstrap ? "Create your first space" : "Operator access"}</h1></div>
        <form id="operator-form" class="stack">
          ${bootstrap ? '<label>Space handle <input name="handle" required autocomplete="off" pattern="[a-z0-9][a-z0-9-]{0,62}"></label>'
            : '<label>Operator credential <input name="token" type="password" required autocomplete="current-password"></label>'}
          <button type="submit">${bootstrap ? "Create space" : "Sign in"}</button>
        </form>
        <p id="operator-status" role="status"></p>
        <div id="operator-result" hidden>
          <p><a id="setup-link" class="button" hidden>Set up your space</a></p>
          <div id="credential-result" hidden><p>Save this operator credential now. It is shown once.</p><textarea id="operator-credential" readonly rows="3"></textarea></div>
          <p><a href="/admin/installations">Manage spaces</a></p>
        </div>
      </section><script src="/operator/client.js" defer></script>` });
    response.headers.set("content-security-policy", "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; style-src 'self'; script-src 'self'; connect-src 'self'");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  }
}

function operatorCookie(token: string): string {
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`;
}

function jsonWithCookie(value: { signedIn?: boolean; signedOut?: boolean }, cookie: string): Response {
  const response = json(value);
  response.headers.set("set-cookie", cookie);
  return response;
}

const OPERATOR_CLIENT = `const section = document.querySelector('[data-bootstrap]');
const bootstrap = section.dataset.bootstrap === 'true';
const operator = section.dataset.mode === 'operator';
const form = document.getElementById('operator-form');
const status = document.getElementById('operator-status');
const storageKey = 'gsv.bootstrap.v1';
function token(label) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return label + '_' + btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
let attempt;
if (bootstrap) {
  const claim = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  try { attempt = JSON.parse(sessionStorage.getItem(storageKey)); } catch { sessionStorage.removeItem(storageKey); }
  if (claim && claim !== attempt?.claim) {
    attempt = { claim, onboardingToken: token('onboard') };
    if (operator) attempt.operatorToken = token('operator');
    sessionStorage.setItem(storageKey, JSON.stringify(attempt));
  }
  if (attempt?.handle) form.elements.handle.value = attempt.handle;
  if (!attempt?.claim) { status.textContent = 'Open the one-time bootstrap link printed by your deployment command.'; form.hidden = true; }
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button'); button.disabled = true;
  try {
    const body = bootstrap ? { ...attempt, handle: form.elements.handle.value } : { token: form.elements.token.value };
    if (bootstrap) { attempt = body; sessionStorage.setItem(storageKey, JSON.stringify(attempt)); }
    const response = await fetch(bootstrap ? '/bootstrap' : '/operator/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The request failed.');
    if (!bootstrap) { location.assign('/admin/installations'); return; }
    form.hidden = true;
    sessionStorage.removeItem(storageKey);
    document.getElementById('operator-result').hidden = false;
    if (result.onboardingUrl) { const link = document.getElementById('setup-link'); link.href = result.onboardingUrl; link.hidden = false; }
    if (result.operatorAccess && attempt.operatorToken) {
      document.getElementById('credential-result').hidden = false;
      document.getElementById('operator-credential').value = attempt.operatorToken;
    }
    status.textContent = result.onboardingUrl ? 'Your first space is ready to set up.' : 'This space already has a setup claim. Use administration if you need to reissue it.';
  } catch (error) { status.textContent = error.message; } finally { button.disabled = false; }
});`;
