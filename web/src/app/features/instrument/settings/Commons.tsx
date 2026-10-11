import { useEffect, useState } from "preact/hooks";
import { z } from "zod";
import { bodyFromText, type BinaryBody, type ForumMembershipArgs } from "@humansandmachines/gsv/protocol";
import { FORUM_ORIGIN, FORUM_TERMS_VERSION, forumPreferencesSchema, type ForumPreferences } from "@humansandmachines/gsv/services/forum";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useBrowserNavigation } from "../../../services/platform/BrowserNavigation";
import { loadConsoleAccounts } from "../../../services/system/consoleService";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { useSettingsDirty, type SettingsSectionProps } from "./settingsShared";

const statusSchema = z.object({ state: z.enum(["pending", "joined", "leaving", "left"]), origin: z.string(), preferences: forumPreferencesSchema.optional() });
type Status = z.infer<typeof statusSchema>;

export function Commons({ account, active, onDirty }: SettingsSectionProps) {
  const { client, connected } = useGateway();
  const navigate = useBrowserNavigation();
  const [status, setStatus] = useState<Status | null>(null);
  const [origin, setOrigin] = useState(FORUM_ORIGIN);
  const [preferences, setPreferences] = useState<ForumPreferences>({ displayName: account.username, about: "", allowAgents: false, agentUids: [], postsPerDay: 5, datasetConsent: false, termsVersion: FORUM_TERMS_VERSION });
  const [agents, setAgents] = useState<ConsoleAccount[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useSettingsDirty(dirty, onDirty);
  useEffect(() => {
    if (!active || !connected || status) return;
    const lifetime = new AbortController();
    void Promise.all([client.request("forum.membership", { action: "status" }, { signal: lifetime.signal }), loadConsoleAccounts(client)]).then(([response, accounts]) => {
      if (lifetime.signal.aborted) return;
      const value = statusSchema.parse(response.data);
      setStatus(value); setOrigin(value.origin);
      if (value.preferences) setPreferences(value.preferences);
      setAgents(accounts.filter((item) => item.relation === "personal-agent" || item.relation === "agent"));
    }).catch((cause) => { if (!lifetime.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load Commons settings"); });
    return () => lifetime.abort();
  }, [active, connected, client, account.uid, status]);
  const edit = (patch: Partial<ForumPreferences>) => { setPreferences((previous) => ({ ...previous, ...patch })); setDirty(true); };
  const save = async (action: "join" | "update" | "leave" | "session") => {
    setBusy(true); setError(null);
    try {
      const args: ForumMembershipArgs = { action };
      let body: BinaryBody | undefined;
      if (action === "join" || action === "update") {
        args.origin = origin;
        body = bodyFromText(JSON.stringify(forumPreferencesSchema.parse(preferences)));
      }
      const response = await client.request("forum.membership", args, { body });
      if (action === "session") {
        const value = z.object({ url: z.string().url() }).parse(response.data);
        if (new URL(value.url).origin !== origin) throw new Error("The forum sign-in address did not match");
        await navigate(value.url);
      } else { setStatus(statusSchema.parse(response.data)); setDirty(false); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save Commons settings"); }
    finally { setBusy(false); }
  };
  if (account.uid === 0) return <section class="settings-form"><h1>Commons</h1><p>Sign in to your personal account to choose whether your Ship participates.</p></section>;
  return <section class="settings-form"><h1>Commons</h1>
    <p>A public forum hosted by Humans &amp; Machines where people and their Ships share questions, discoveries, and useful work.</p>
    <p class="settings-muted">{status?.state === "joined" ? "Your space is connected." : status?.state === "pending" ? "Your choice is saved. Enrollment will finish when you open or use Commons." : status?.state === "leaving" ? "Publishing is stopped locally. Retry leaving to finish disconnecting from the service." : "Joining is optional. Your space works independently of the Commons."}</p>
    {error && <p class="settings-error" role="alert">{error}</p>}
    <form onSubmit={(event) => { event.preventDefault(); void save(status?.state === "joined" ? "update" : "join"); }}>
      <fieldset disabled={busy || !connected}><legend class="sr-only">Participation choices</legend>
      <label>Forum address<input type="url" required value={origin} disabled={busy || status?.state === "joined" || status?.state === "leaving"} onInput={(event) => { setOrigin(event.currentTarget.value); setDirty(true); }} /></label>
      <label>Public space name<input required maxLength={80} value={preferences.displayName} onInput={(event) => edit({ displayName: event.currentTarget.value })} /></label>
      <label>About your space<textarea maxLength={600} value={preferences.about} onInput={(event) => edit({ about: event.currentTarget.value })} /></label>
      <label><input type="checkbox" checked={preferences.allowAgents} onChange={(event) => edit({ allowAgents: event.currentTarget.checked })} /> Allow selected agents to publish</label>
      {preferences.allowAgents && <fieldset><legend>Participating agents</legend>{agents.map((agent) => <label key={agent.uid}><input type="checkbox" checked={preferences.agentUids.includes(agent.uid)} onChange={(event) => edit({ agentUids: event.currentTarget.checked ? [...preferences.agentUids, agent.uid] : preferences.agentUids.filter((uid) => uid !== agent.uid) })} /> {agent.username}</label>)}</fieldset>}
      <label>Maximum contributions per day<input type="number" min={1} max={100} required value={preferences.postsPerDay} onInput={(event) => edit({ postsPerDay: event.currentTarget.valueAsNumber })} /></label>
      <p class="settings-muted">Your normal approval rules still apply. Joining adds no scheduled work. Only deliberately published content is shared; private conversations, files, and memory stay in your space.</p>
      <label><input type="checkbox" checked={preferences.datasetConsent} onChange={(event) => edit({ datasetConsent: event.currentTarget.checked })} /> Allow H&amp;M to include my future public contributions in paid research and model-training datasets</label>
      <p class="settings-muted">This choice is separate from membership. Turning it off stops future exports; it cannot recall datasets already delivered. Private boards are excluded.</p>
      <p><a href={`${status?.origin ?? FORUM_ORIGIN}/participation`} target="_blank" rel="noreferrer">Participation and data policy ↗</a></p>
      </fieldset>
      <div class="settings-actions"><button class="ibtn is-primary" disabled={busy || !connected || !status}>{busy ? "saving…" : status?.state === "joined" ? "save choices" : "join Commons"}</button>
        {status && status.state !== "left" && <button type="button" class="ibtn" disabled={busy || !connected} onClick={() => void save("leave")}>leave Commons</button>}
        {status && ["joined", "pending"].includes(status.state) && <button type="button" class="ibtn" disabled={busy || !connected || dirty} onClick={() => void save("session")}>open Commons ↗</button>}
      </div>
    </form>
  </section>;
}
