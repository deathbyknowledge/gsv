import { prepareSiteClient, type PreparedSiteClient, type SiteClientSession } from "@humansandmachines/gsv/site-client";
import type { ResponsibilityRecord, ResponsibilityState } from "@humansandmachines/gsv/protocol";

const connectButton = document.querySelector<HTMLButtonElement>("#connect")!;
const notice = document.querySelector<HTMLParagraphElement>("#notice")!;
const welcome = document.querySelector<HTMLElement>("#welcome")!;
const board = document.querySelector<HTMLElement>("#board")!;
const list = document.querySelector<HTMLUListElement>("#work")!;
const detail = document.querySelector<HTMLElement>("#detail")!;
const count = document.querySelector<HTMLElement>("#count")!;
const empty = document.querySelector<HTMLElement>("#empty")!;
const sessionLabel = document.querySelector<HTMLElement>("#session")!;
const filters = [...document.querySelectorAll<HTMLButtonElement>("[data-state]")];
const states = { open: "Open", active: "In progress", waiting: "Waiting", resolved: "Done", cancelled: "Cancelled" } satisfies Record<ResponsibilityState, string>;
let prepared: PreparedSiteClient;
let session: SiteClientSession | null = null;
let records: ResponsibilityRecord[] = [];
let selected: string | null = null;
let filter = "all";
let generation = 0;
let listRequest = 0;
let detailRequest = 0;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let unsubscribe: Array<() => void> = [];

function text<K extends keyof HTMLElementTagNameMap>(tag: K, value: string, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

function date(value: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(value);
}

function renderList(): void {
  const visible = records.filter(record => filter === "all" || record.state === filter);
  list.replaceChildren(...visible.map(record => {
    const row = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "work-item";
    button.setAttribute("aria-pressed", String(selected === record.id));
    const dot = text("span", "", `state-dot ${record.state}`);
    dot.setAttribute("aria-hidden", "true");
    const copy = text("span", "", "work-copy");
    copy.append(text("span", record.title, "work-title"), text("span", [states[record.state],
      record.dueAtMs ? `Due ${date(record.dueAtMs)}` : record.assignee.kind === "ship" ? "Ship" : "Delegated work",
    ].join(" · "), "work-meta"));
    button.append(dot, copy);
    button.addEventListener("click", () => { selected = record.id; renderList(); void loadDetail(record.id); });
    row.append(button);
    return row;
  }));
  empty.hidden = visible.length > 0;
}

async function loadDetail(id: string): Promise<void> {
  const current = session;
  if (!current) return;
  const request = ++detailRequest;
  try {
    const { responsibility: record } = await current.client.r12y.get({ id });
    if (session !== current || request !== detailRequest) return;
    const values = document.createElement("dl");
    for (const [label, value] of [["Status", states[record.state]], ["Priority", record.priority],
      ["Assigned", record.assignee.kind === "ship" ? "Ship" : "Delegated work"],
      ["Updated", date(record.updatedAtMs)], ...(record.dueAtMs ? [["Due", date(record.dueAtMs)]] : [])]) {
      values.append(text("dt", label), text("dd", value));
    }
    detail.replaceChildren(text("p", "RESPONSIBILITY", "eyebrow"), text("h2", record.title), values);
    if (record.blocker) detail.append(text("p", record.blocker, "blocker"));
  } catch {
    if (session === current && request === detailRequest) detail.replaceChildren(text("p", "This responsibility is unavailable.", "muted"));
  }
}

async function refresh(): Promise<void> {
  const current = session;
  if (!current) return;
  const request = ++listRequest;
  try {
    const result = await current.client.r12y.list({ includeTerminal: false, limit: 100 });
    if (session !== current || request !== listRequest) return;
    records = result.responsibilities;
    count.textContent = result.count > records.length ? `Showing ${records.length} of ${result.count}` : `${records.length} responsibilities`;
    renderList();
    if (selected) void loadDetail(selected);
    notice.textContent = "";
  } catch {
    if (session === current) notice.textContent = "Couldn’t update the board. Disconnect and connect again to retry.";
  }
}

function disconnect(message = "Disconnected. Your responsibilities have been cleared from this page."): void {
  generation += 1;
  unsubscribe.forEach(stop => stop());
  unsubscribe = [];
  clearTimeout(refreshTimer);
  session?.close();
  session = null;
  records = [];
  selected = null;
  list.replaceChildren();
  detail.replaceChildren(text("p", "Choose a responsibility to see its details.", "muted"));
  board.hidden = true;
  welcome.hidden = false;
  connectButton.disabled = false;
  connectButton.textContent = "Connect to Ship";
  notice.textContent = message;
}

connectButton.addEventListener("click", () => {
  if (session) { disconnect(); return; }
  const attempt = ++generation;
  // connect() opens its popup before its first asynchronous operation.
  const pending = prepared.connect();
  connectButton.disabled = true;
  notice.textContent = "Finish signing in in the popup.";
  void pending.then(connected => {
    if (generation !== attempt) { connected.close(); return; }
    session = connected;
    board.hidden = false;
    welcome.hidden = true;
    connectButton.disabled = false;
    connectButton.textContent = "Disconnect";
    sessionLabel.textContent = `Live · Read-only until ${date(connected.expiresAtMs)}`;
    unsubscribe = [connected.client.onSignal(signal => {
      if (signal !== "r12y.changed") return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { void refresh(); }, 150);
    }), connected.client.onStatus(status => {
      if (status.state === "disconnected") disconnect("Connection ended. Connect again when you’re ready.");
    })];
    void refresh();
  }).catch(error => {
    if (generation === attempt) disconnect(error instanceof Error ? error.message : "Couldn’t connect to this space.");
  });
});

filters.forEach(button => button.addEventListener("click", () => {
  filter = button.dataset.state!;
  filters.forEach(item => item.setAttribute("aria-pressed", String(item === button)));
  renderList();
}));

void prepareSiteClient().then(client => {
  prepared = client;
  connectButton.disabled = false;
  notice.textContent = "";
}).catch(() => {
  notice.textContent = "Open this board from its published site to connect to Ship.";
});
