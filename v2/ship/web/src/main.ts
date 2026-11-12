import { connect, GsvRequestError } from "@gsv/sdk";
import { z } from "zod";

const sessionSchema = z.object({ token: z.string(), expiresAt: z.number() });
type Session = z.infer<typeof sessionSchema>;
const setupAnswerSchema = z.union([sessionSchema.extend({ host: z.string() }), z.object({ error: z.object({ message: z.string() }) })]);

const SESSION_KEY = "gsv.session";
const main = document.querySelector("main") ?? document.body;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  return node;
}

function show(title: string, body: string): void {
  main.replaceChildren(element("h1", title), element("p", body));
}

function savedSession(): Session | null {
  try {
    const session = sessionSchema.safeParse(JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null"));
    return session.success && session.data.expiresAt > Date.now() ? session.data : null;
  } catch {
    return null;
  }
}

/** Redeems the one-time setup link for the deployment's first space. */
function setup(): void {
  const code = location.hash.slice(1);
  // The code leaves the address bar as soon as it is read.
  history.replaceState(null, "", location.pathname);
  if (!code) return show("This setup link is incomplete", "Open the whole link that gsv printed.");

  const name = element("input");
  name.required = true;
  name.autocomplete = "name";
  name.placeholder = "Your name";
  const submit = element("button", "Create the space");
  const status = element("p");
  status.setAttribute("role", "alert");
  const form = element("form");
  form.append(name, submit, status);
  main.replaceChildren(element("h1", "Set up this deployment"), element("p", "This creates its first space. You'll be its admin."), form);

  form.addEventListener("submit", event => {
    event.preventDefault();
    submit.disabled = true;
    status.textContent = "";
    void fetch("/_gsv/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: name.value }),
    }).then(response => response.json()).then(json => {
      const answer = setupAnswerSchema.parse(json);
      if ("error" in answer) throw new Error(answer.error.message);
      localStorage.setItem(SESSION_KEY, JSON.stringify({ token: answer.token, expiresAt: answer.expiresAt }));
      location.replace("/");
    }).catch((cause: unknown) => {
      status.textContent = cause instanceof Error ? cause.message : "Setup didn't finish. Try again.";
      submit.disabled = false;
    });
  });
}

async function home(): Promise<void> {
  const session = savedSession();
  if (!session) return show("Ship", "Sign-in isn't built yet. A deployment's first space starts from its setup link.");
  show("Ship", "Connecting…");
  try {
    const gsv = await connect({
      host: location.host,
      token: session.token,
      insecure: location.protocol === "http:",
      client: { name: "ship-web", version: "0", platform: "web" },
    });
    show("Ship", `Connected to your space as ${gsv.info?.person ?? "you"}.`);
  } catch (cause) {
    show("Ship", cause instanceof GsvRequestError ? cause.message : "Couldn't reach your space.");
  }
}

if (location.pathname === "/setup") setup();
else void home();
