import "./panel.css";
import { configReady, normalizeGatewayUrl, type ExtensionConfig } from "../shared/config";
import { liveAccessCount, timeUntil } from "../shared/status-format";
import { escapeHtml, formatDuration, sendUiMessage, timeAgo, truncateMiddle } from "../shared/ui-client";
import type { ActivityEntry, ExtensionUiState, RuntimeResponse } from "../shared/ui-state";

// The extension's one surface. It is the side panel, and the same page opened full-width from
// chrome://extensions (the manifest's options page points here too). Everything a person needs
// to read is a sentence in Host Grotesk; the machine's labels stay tracked uppercase Martian Mono.

type Notice = { kind: "info" | "error"; text: string };
type ConfigField = keyof ExtensionConfig;

const BANNER_NOTE_KEY = "gsvExtensionBannerNoteSeen";
const isPage = document.documentElement.dataset.mode === "page";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Missing #app");
const appEl = app;
appEl.className = isPage ? "panel is-page" : "panel";

let state: ExtensionUiState | null = null;
let busy: string | null = null;
let notice: Notice | null = null;
let showBannerNote = false;
let advancedOpen = false;
let tokenVisible = false;
let draft: ExtensionConfig | null = null;
let fieldErrors: Partial<Record<ConfigField, string>> = {};

appEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest<HTMLButtonElement>("button[data-action]");
  if (button?.dataset.action) void runAction(button.dataset.action);
});
appEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (form.dataset.form === "pair") void pair(form);
  if (form.dataset.form === "connection") void saveConnection(form);
});
appEl.addEventListener("toggle", (event) => {
  const details = event.target;
  if (details instanceof HTMLDetailsElement && details.classList.contains("advanced")) advancedOpen = details.open;
}, true);
appEl.addEventListener("input", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.form || input.form.dataset.form !== "connection") return;
  draft = readConnectionForm(input.form);
  fieldErrors = validate(draft);
  paintValidation(input.form);
});

void chrome.storage.local.get(BANNER_NOTE_KEY).then((stored) => {
  showBannerNote = stored[BANNER_NOTE_KEY] === false;
  render();
}).catch(() => {});
void refresh();
setInterval(() => void refresh(), 2_000);

async function refresh(): Promise<void> {
  try {
    apply(await sendUiMessage({ type: "status" }));
  } catch (error) {
    notice = { kind: "error", text: errorText(error) };
    render();
  }
}

function apply(response: RuntimeResponse): void {
  if (response.ok) {
    state = response.state;
  } else {
    state = response.state ?? state;
    notice = { kind: "error", text: response.error };
  }
  render();
}

async function runAction(action: string): Promise<void> {
  if (busy) return;
  busy = action;
  render();
  try {
    switch (action) {
      case "connect":
      case "resume":
      case "retry":
        apply(await sendUiMessage({ type: "connect" }));
        break;
      case "pause":
        apply(await sendUiMessage({ type: "disconnect" }));
        break;
      case "stop":
        apply(await sendUiMessage({ type: "stop-all" }));
        break;
      case "allow-recording":
        apply(await sendUiMessage({ type: "grant-media-capture" }));
        break;
      case "refresh":
        apply(await sendUiMessage({ type: "refresh" }));
        break;
      case "clear-diagnostics":
        if (confirm("Forget this browser's recent activity and diagnostics?")) apply(await sendUiMessage({ type: "clear-diagnostics" }));
        break;
      case "copy-diagnostics":
        if (state) {
          const { config: _config, ...rest } = state;
          await navigator.clipboard.writeText(JSON.stringify(rest, null, 2));
          notice = { kind: "info", text: "Diagnostics copied." };
        }
        break;
      case "dismiss-note":
        showBannerNote = false;
        await chrome.storage.local.set({ [BANNER_NOTE_KEY]: true });
        break;
      case "dismiss-notice":
        notice = null;
        break;
      case "open-page":
        await chrome.runtime.openOptionsPage();
        break;
      case "toggle-token":
        tokenVisible = !tokenVisible;
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  } catch (error) {
    notice = { kind: "error", text: errorText(error) };
  } finally {
    busy = null;
    render();
  }
}

async function pair(form: HTMLFormElement): Promise<void> {
  const field = form.elements.namedItem("invitation");
  if (!(field instanceof HTMLTextAreaElement)) return;
  busy = "pair";
  render();
  try {
    const response = await sendUiMessage({ type: "pair", code: field.value.trim() });
    apply(response);
    if (response.ok) {
      notice = null;
      // The first time Chrome shows its debugging banner is right after pairing; say so once.
      showBannerNote = true;
      await chrome.storage.local.set({ [BANNER_NOTE_KEY]: false });
    }
  } catch (error) {
    notice = { kind: "error", text: errorText(error) };
  } finally {
    busy = null;
    render();
  }
}

async function saveConnection(form: HTMLFormElement): Promise<void> {
  draft = readConnectionForm(form);
  fieldErrors = validate(draft);
  paintValidation(form);
  if (Object.keys(fieldErrors).length > 0) return;
  busy = "save";
  render();
  try {
    const response = await sendUiMessage({ type: "save-config", config: draft });
    apply(response);
    if (response.ok) {
      draft = null;
      notice = { kind: "info", text: "Connection settings saved." };
    }
  } catch (error) {
    notice = { kind: "error", text: errorText(error) };
  } finally {
    busy = null;
    render();
  }
}

/* ---------- render ---------- */

function render(): void {
  if (!state) {
    appEl.innerHTML = `<p class="loading">Reaching your GSV…</p>`;
    return;
  }
  const paired = configReady(state.config);
  appEl.innerHTML = [
    header(state, paired),
    paired ? main(state) : pairing(state),
    noticeBlock(),
    paired ? recent(state) : "",
    paired ? advanced(state) : "",
    footer(state, paired),
  ].join("");
  const form = appEl.querySelector<HTMLFormElement>("form[data-form='connection']");
  if (form) paintValidation(form);
}

function header(current: ExtensionUiState, paired: boolean): string {
  const mood = paired ? tone(current) : "idle";
  const label = !paired ? "not paired"
    : liveAccessCount(current) > 0 ? "working"
    : current.connection.state === "connected" ? "ready"
    : current.connection.state === "connecting" ? "connecting"
    : current.connection.reconnectSuppressed ? "paused"
    : "offline";
  return `
    <header class="top">
      <span class="wordmark">GSV</span>
      <span class="state"><span class="dot ${escapeHtml(mood)}"></span>${escapeHtml(label)}</span>
    </header>`;
}

function main(current: ExtensionUiState): string {
  const live = liveAccessCount(current);
  const connected = current.connection.state === "connected";
  const connecting = current.connection.state === "connecting";
  const paused = current.connection.reconnectSuppressed;
  const grant = current.media.captureGrant;

  let title: string;
  let detail: string;
  let detailClass = "";
  const actions: string[] = [];

  if (live > 0) {
    const site = workingSite(current);
    title = "Your GSV is working here.";
    detail = site ? `It's using <span class="site">${escapeHtml(site)}</span> right now. ${liveSentence(current)}` : liveSentence(current);
    actions.push(button("stop", "stop", "ibtn"));
  } else if (connected) {
    title = "Ready.";
    detail = "Your GSV can use this browser, signed in as you. Ask it from anywhere.";
    actions.push(textButton("allow-recording", "allow recording of this tab"));
    actions.push(textButton("pause", "pause"));
  } else if (connecting) {
    title = "Connecting to your GSV…";
    detail = "This usually takes a moment.";
  } else if (paused) {
    title = "Paused.";
    detail = "Your GSV can't use this browser until you resume.";
    actions.push(button("resume", "resume", "ibtn is-primary"));
  } else {
    title = "Can't reach your GSV.";
    detail = current.connection.message || "The connection dropped. It will retry on its own; you can also try now.";
    detailClass = "is-err";
    actions.push(button("retry", "try again", "ibtn is-primary"));
  }

  const grantLine = grant
    ? `<p>Recording is allowed on <span class="site">${escapeHtml(grant.title || grant.url || `tab ${grant.tabId}`)}</span> for ${escapeHtml(timeUntil(grant.expiresAt))}.</p>`
    : "";
  const bannerNote = showBannerNote
    ? `<div class="note"><p>Chrome shows a banner at the top of a tab while your GSV works in it. That's normal, and it goes when it's done.</p><div class="actions">${textButton("dismiss-note", "got it")}</div></div>`
    : "";

  return `
    <section class="say">
      <h1>${escapeHtml(title)}</h1>
      <p class="${detailClass}">${detail}</p>
      ${grantLine}
    </section>
    ${actions.length ? `<div class="actions">${actions.join("")}</div>` : ""}
    ${bannerNote}`;
}

function pairing(current: ExtensionUiState): string {
  const pending = busy === "pair";
  return `
    <section class="say">
      <h1>Let your GSV use this browser.</h1>
      <p>Once paired, it can work the sites you're signed into, from wherever you ask.</p>
    </section>
    <form class="pair" data-form="pair">
      <ol>
        <li>In your GSV, open Fleet and choose Connect.</li>
        <li>Pick Browser and copy the invitation.</li>
        <li>Paste it here.</li>
      </ol>
      <textarea name="invitation" placeholder="gsv-pair1_…" autocomplete="off" spellcheck="false" ${pending ? "disabled" : ""}></textarea>
      <div class="actions">
        <button type="submit" class="ibtn is-primary" ${pending ? "disabled" : ""}>${pending ? "pairing…" : "pair this browser"}</button>
        ${current.connection.message ? `<span class="tbtn" aria-hidden="true">${escapeHtml(truncateMiddle(current.connection.message, 48))}</span>` : ""}
      </div>
    </form>`;
}

function noticeBlock(): string {
  if (!notice) return "";
  return `
    <div class="note ${notice.kind === "error" ? "is-err" : ""}">
      <p>${escapeHtml(notice.text)}</p>
      <div class="actions">${textButton("dismiss-notice", "dismiss")}</div>
    </div>`;
}

function recent(current: ExtensionUiState): string {
  const rows = current.activity.filter((entry) => entry.kind !== "connection").slice(0, 6);
  return `
    <section class="recent">
      <span class="eyebrow">recent <span class="count">${rows.length ? String(rows.length) : ""}</span></span>
      ${rows.length
        ? `<div class="rows">${rows.map(row).join("")}</div>`
        : `<p class="empty">Nothing yet. Ask your GSV to do something in this browser and it shows up here.</p>`}
    </section>`;
}

function row(entry: ActivityEntry): string {
  const when = [timeAgo(entry.at), formatDuration(entry.durationMs)].filter(Boolean).join(" · ");
  const mood = entry.status === "error" ? "is-err" : entry.status === "active" ? "is-live" : entry.kind === "sensitive" ? "is-accent" : "is-on";
  return `
    <div class="row ${entry.status === "error" ? "is-err" : ""}">
      <span class="dot ${mood}"></span>
      <span class="what" title="${escapeHtml(entry.label)}">${escapeHtml(what(entry))}</span>
      <span class="when" title="${escapeHtml(entry.at)}">${escapeHtml(when)}</span>
      ${entry.detail && entry.detail !== "(no path)" ? `<span class="where" title="${escapeHtml(entry.detail)}">${escapeHtml(truncateMiddle(entry.detail, 64))}</span>` : ""}
    </div>`;
}

function advanced(current: ExtensionUiState): string {
  const config = draft ?? current.config;
  const paused = current.connection.reconnectSuppressed;
  return `
    <details class="advanced" ${advancedOpen ? "open" : ""}>
      <summary>advanced</summary>
      <div class="body">
        <section>
          <h3>connection</h3>
          <form class="form" data-form="connection" novalidate>
            ${field("gatewayUrl", "your gsv", config.gatewayUrl, "text", "yours.gsv.space")}
            ${field("username", "username", config.username, "text")}
            <label class="field" data-field="token"><span>credential</span>
              <span class="with-action">
                <input name="token" type="${tokenVisible ? "text" : "password"}" value="${escapeHtml(config.token)}" autocomplete="off">
                ${textButton("toggle-token", tokenVisible ? "hide" : "show")}
              </span><small data-error></small></label>
            ${field("deviceId", "this browser's name", config.deviceId, "text", "laptop:chrome")}
            <label class="check"><input name="autoConnect" type="checkbox" ${config.autoConnect ? "checked" : ""}> connect when Chrome starts</label>
            <div class="actions">
              <button type="submit" class="ibtn" ${busy === "save" ? "disabled" : ""}>${busy === "save" ? "saving…" : "save"}</button>
              ${paused ? textButton("resume", "resume") : textButton("pause", "pause")}
            </div>
          </form>
        </section>
        <section>
          <h3>details</h3>
          <dl class="facts">
            ${fact("gsv", current.gatewayHost)}
            ${fact("this browser", current.targetId)}
            ${fact("connection", current.connection.connectionId ?? "—")}
            ${fact("last connected", current.diagnostics.lastConnectedAt ? timeAgo(current.diagnostics.lastConnectedAt) : "—")}
            ${fact("last error", current.diagnostics.lastError ? truncateMiddle(current.diagnostics.lastError, 60) : "—")}
            ${fact("stored files", String(current.artifact.files))}
          </dl>
          <div class="actions" style="margin-top:10px">
            ${textButton("refresh", "refresh")}
            ${textButton("copy-diagnostics", "copy diagnostics")}
            ${textButton("clear-diagnostics", "forget history", "is-danger")}
            ${isPage ? "" : textButton("open-page", "open as a page")}
          </div>
        </section>
      </div>
    </details>`;
}

function footer(current: ExtensionUiState, paired: boolean): string {
  return `
    <footer class="foot">
      <span>your gsv</span>
      <span class="host" title="${escapeHtml(current.config.gatewayUrl)}">${escapeHtml(paired ? current.gatewayHost : "not paired yet")}</span>
    </footer>`;
}

/* ---------- pieces ---------- */

function button(action: string, label: string, className: string): string {
  return `<button type="button" class="${className}" data-action="${escapeHtml(action)}" ${busy === action ? "disabled" : ""}>${escapeHtml(label)}</button>`;
}
function textButton(action: string, label: string, extra = ""): string {
  return `<button type="button" class="tbtn ${extra}" data-action="${escapeHtml(action)}" ${busy === action ? "disabled" : ""}>${escapeHtml(label)}</button>`;
}
function field(name: ConfigField, label: string, value: string, type: string, placeholder = ""): string {
  return `<label class="field" data-field="${name}"><span>${escapeHtml(label)}</span><input name="${name}" type="${type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" autocomplete="off"><small data-error></small></label>`;
}
function fact(label: string, value: string): string {
  return `<dt>${escapeHtml(label)}</dt><dd title="${escapeHtml(value)}">${escapeHtml(value)}</dd>`;
}

function tone(current: ExtensionUiState): string {
  if (liveAccessCount(current) > 0) return "is-live";
  if (current.connection.state === "connected") return "is-on";
  if (current.connection.state === "connecting") return "is-live";
  if (current.connection.reconnectSuppressed) return "";
  return "is-err";
}

/** The site your GSV is in, from the newest active row that names one. */
function workingSite(current: ExtensionUiState): string | null {
  for (const entry of current.activity) {
    if (entry.kind === "connection") continue;
    const match = entry.detail.match(/https?:\/\/([^/\s]+)/);
    if (match) return match[1];
  }
  return null;
}

function liveSentence(current: ExtensionUiState): string {
  const parts: string[] = [];
  const tabs = current.sensitive.debuggerTabs.length;
  if (tabs > 0) parts.push(tabs === 1 ? "one tab is in use" : `${tabs} tabs are in use`);
  if (current.sensitive.networkCaptures > 0) parts.push("it's watching network traffic");
  if (current.sensitive.mediaRecordings > 0) parts.push("it's recording");
  if (parts.length === 0) return "Stop ends everything it's doing here.";
  const sentence = parts.join(", ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}. Stop ends all of it.`;
}

/** What an activity row did, in the person's words. */
function what(entry: ActivityEntry): string {
  const label = entry.label.toLowerCase();
  if (entry.status === "error") return `Couldn't ${verb(label)}`;
  if (label === "page screenshot") return "Took a screenshot";
  if (label === "page text") return "Read a page";
  if (label === "page js" || label.startsWith("page ")) return "Worked on a page";
  if (label.startsWith("network")) return "Watched network traffic";
  if (label.startsWith("fs.")) return "Worked with a file";
  if (label.startsWith("shell") || label === "exec") return "Ran a command";
  if (label.includes("record")) return "Recorded";
  if (label.includes("tab")) return "Used a tab";
  return entry.label.charAt(0).toUpperCase() + entry.label.slice(1);
}
function verb(label: string): string {
  if (label.startsWith("page")) return "finish on a page";
  if (label.startsWith("fs.")) return "finish a file operation";
  if (label.startsWith("network")) return "capture network traffic";
  return "finish";
}

/* ---------- connection form ---------- */

function readConnectionForm(form: HTMLFormElement): ExtensionConfig {
  const text = (name: string) => { const el = form.elements.namedItem(name); return el instanceof HTMLInputElement ? el.value.trim() : ""; };
  const auto = form.elements.namedItem("autoConnect");
  return {
    gatewayUrl: text("gatewayUrl"),
    username: text("username"),
    token: text("token"),
    deviceId: text("deviceId"),
    autoConnect: auto instanceof HTMLInputElement ? auto.checked : true,
  };
}

function validate(config: ExtensionConfig): Partial<Record<ConfigField, string>> {
  const errors: Partial<Record<ConfigField, string>> = {};
  if (!normalizeGatewayUrl(config.gatewayUrl)) errors.gatewayUrl = "Enter your GSV's address, like yours.gsv.space.";
  if (!config.username) errors.username = "Username is required.";
  if (!config.token) errors.token = "A credential is required. Pairing fills this in.";
  if (!config.deviceId) errors.deviceId = "Give this browser a name.";
  else if (/\s/.test(config.deviceId)) errors.deviceId = "No spaces in the name.";
  return errors;
}

function paintValidation(form: HTMLFormElement): void {
  for (const name of ["gatewayUrl", "username", "token", "deviceId"] as ConfigField[]) {
    const wrap = form.querySelector<HTMLElement>(`[data-field="${name}"]`);
    const small = wrap?.querySelector<HTMLElement>("[data-error]");
    const message = draft ? fieldErrors[name] ?? "" : "";
    wrap?.classList.toggle("is-invalid", Boolean(message));
    if (small) small.textContent = message;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
