import { useEffect, useRef, useState } from "preact/hooks";
import { useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { CloudInstance, SysInstanceStartArgs } from "@humansandmachines/gsv/protocol";
import { instanceStartSchema } from "@humansandmachines/gsv/services/instances";
import { z } from "zod";
import { useSession } from "../../../services/session/SessionProvider";
import { FleetDialog } from "../fleet/FleetDialog";
import { INSTANCE_QUERY_KEY, PROFILE_QUERY_KEY, useBrowserControl, useCloudInstances } from "./BrowserControl";

const browserTab = z.object({ id: z.number().int().positive(), title: z.string().nullable(), url: z.string().nullable() })
  .transform(tab => ({ id: tab.id, title: tab.title ?? "", url: tab.url ?? "" }));

export function StartCloudBrowser({ allowed }: { allowed: boolean }) {
  const { available } = useBrowserControl();
  const { client, connected } = useGateway();
  const { snapshot } = useSession();
  const queryClient = useQueryClient();
  const pendingKey = `gsv:browser-start:${snapshot.username}`;
  const [pending, setPending] = useState<SysInstanceStartArgs | null>(() => {
    const saved = sessionStorage.getItem(pendingKey);
    if (!saved) return null;
    try { return instanceStartSchema.parse(JSON.parse(saved)); } catch { sessionStorage.removeItem(pendingKey); return null; }
  });
  const [open, setOpen] = useState(false), [selected, setSelected] = useState(""), [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const profileId = useRef(crypto.randomUUID());
  const profiles = useQuery({ queryKey: PROFILE_QUERY_KEY, queryFn: () => client.sys.browser.profile.list({}), enabled: available && open && connected });
  const catalog = useQuery({ queryKey: ["instance-catalog"], queryFn: () => client.sys.instance.catalog({}), enabled: available && open && connected });
  const template = catalog.data?.templates.find(item => item.kind === "browser");
  const usage = catalog.data?.usage;
  const clearPending = () => { sessionStorage.removeItem(pendingKey); setPending(null); };
  if (!available) return null;
  const start = async () => {
    setBusy(true); setError("");
    try {
      const args = pending ?? { requestId: crypto.randomUUID(), templateId: "browser", profileId: selected || undefined };
      sessionStorage.setItem(pendingKey, JSON.stringify(args)); setPending(args);
      await client.sys.instance.start(args);
      clearPending();
      await queryClient.invalidateQueries({ queryKey: INSTANCE_QUERY_KEY }); setOpen(false);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  const create = async () => {
    setBusy(true); setError("");
    try {
      const result = await client.sys.browser.profile.create({ requestId: profileId.current, label: label.trim() });
      profileId.current = crypto.randomUUID(); setSelected(result.profile.profileId); setLabel("");
      await queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  return <>
    <button type="button" class="fleet-heading-action" disabled={!allowed || !connected} onClick={() => setOpen(true)}>start browser</button>
    <FleetDialog open={open} title="Start a cloud browser" onClose={() => { if (!busy) setOpen(false); }}>
      <div class="browser-start">
        <p>Use websites while your own devices are offline.</p>
        {pending && <p role="status">A previous start has not been confirmed. Retry the same request or cancel it before starting another browser.</p>}
        <label>Saved logins<select value={pending?.profileId ?? selected} disabled={busy || Boolean(pending)} onChange={event => setSelected(event.currentTarget.value)}>
          <option value="">Temporary browser</option>
          {profiles.data?.profiles.filter(item => item.state === "active").map(item => <option value={item.profileId} disabled={Boolean(item.activeInstanceId)}>{item.label}{item.activeInstanceId ? " · in use" : ""}</option>)}
        </select></label>
        {!selected && <p class="note">Temporary browsers forget their logins when stopped. Create a profile to keep them.</p>}
        <div class="browser-profile-create"><input aria-label="New profile name" placeholder="Profile name" value={label} disabled={busy || Boolean(pending)} onInput={event => { setLabel(event.currentTarget.value); profileId.current = crypto.randomUUID(); }} />
          <button type="button" disabled={busy || Boolean(pending) || !label.trim()} onClick={() => void create()}>save a new profile</button></div>
        {selected && !pending && <button type="button" disabled={busy} onClick={async () => {
          setBusy(true); setError("");
          try { await client.sys.browser.profile.delete({ profileId: selected }); setSelected(""); await queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY }); }
          catch (cause) { setError(String(cause)); } finally { setBusy(false); }
        }}>delete this saved profile</button>}
        {template && <p>Stops after {Math.round(template.defaultLifetimeSeconds / 60)} minutes. You or Ship can stop it sooner.</p>}
        {usage && <p class="note">{Math.max(0, Math.floor((usage.limitSeconds - usage.usedSeconds - usage.reservedSeconds) / 60))} browser minutes available · {usage.activeInstances} of {usage.concurrentLimit} browsers in use</p>}
        {(error || catalog.error || profiles.error) && <p class="error" role="alert">{error || String(catalog.error || profiles.error)}</p>}
        <button class="fleet-text-action is-primary" type="button" disabled={busy || (!template && !pending)} onClick={() => void start()}>{busy ? "Starting…" : pending ? "retry start" : "start browser"}</button>
        {pending && <button type="button" disabled={busy} onClick={async () => {
          setBusy(true); setError("");
          try { await client.sys.instance.stop({ startRequestId: pending.requestId }); clearPending(); await queryClient.invalidateQueries({ queryKey: INSTANCE_QUERY_KEY }); }
          catch (cause) { setError(String(cause)); } finally { setBusy(false); }
        }}>cancel start</button>}
      </div>
    </FleetDialog>
  </>;
}

export function CloudBrowserActions({ targetId, allowed }: { targetId: string; allowed: boolean }) {
  const { client, connected } = useGateway();
  const { open } = useBrowserControl();
  const inventory = useCloudInstances();
  const queryClient = useQueryClient();
  const instance = inventory.data?.instances.find(item => item.targetId === targetId);
  const saved = useQuery({ queryKey: [...PROFILE_QUERY_KEY, instance?.profileId], queryFn: () => client.sys.browser.profile.get({ profileId: instance!.profileId! }), enabled: connected && Boolean(instance?.profileId), refetchInterval: 5000 });
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [tabId, setTabId] = useState(1), [url, setUrl] = useState("");
  const [tabs, setTabs] = useState<Array<{ id: number; title: string; url: string }>>([]);
  const handoff = inventory.data?.handoffs.find(item => item.instanceId === instance?.instanceId);
  const requestId = useRef(crypto.randomUUID());
  useEffect(() => {
    if (!instance || instance.state !== "ready" || handoff) return;
    let live = true;
    void client.shell.exec({ target: targetId, input: "tabs list" }).then(result => {
      if (!live) return;
      if (result.status !== "completed") throw new Error(result.status === "failed" ? result.error : "Browser command is still running");
      const { tabs: rows } = z.object({ tabs: z.array(browserTab) }).parse(JSON.parse(result.output));
      setTabs(rows); if (rows[0]) setTabId(rows[0].id);
    }).catch(cause => { if (live) setError(String(cause)); });
    return () => { live = false; };
  }, [client, targetId, instance?.state, handoff?.requestId]);
  const act = async (work: (value: CloudInstance) => Promise<void>) => {
    if (!instance) return;
    setBusy(true); setError("");
    try { await work(instance); await queryClient.invalidateQueries({ queryKey: INSTANCE_QUERY_KEY }); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  return <section class="browser-actions">
    <h4>Cloud browser</h4>
    <p>{instance ? `${instance.state} · ${Math.max(0, Math.ceil((instance.expiresAt - Date.now()) / 60000))} minutes remaining` : "This browser has stopped."}</p>
    {saved.data?.profile && <p class="note">{saved.data.profile.saveStatus === "saved" ? `Logins last saved ${new Date(saved.data.profile.savedAt!).toLocaleTimeString()}.` : saved.data.profile.saveStatus === "failed" ? "The latest login changes could not be saved. Keep this browser open and try again." : "No logins saved yet. Sign in, then return control to save them."}</p>}
    {tabs.length > 0 && <label>Tab<select value={tabId} onChange={event => { setTabId(Number(event.currentTarget.value)); requestId.current = crypto.randomUUID(); }}>{tabs.map(tab => <option value={tab.id}>{tab.title || tab.url || "New tab"}</option>)}</select></label>}
    {instance?.state === "ready" && !handoff && <form onSubmit={event => { event.preventDefault(); void act(async value => {
      const destination = new URL(url.includes("://") ? url : `https://${url}`);
      if (!/^https?:$/.test(destination.protocol)) throw new Error("Enter a website address");
      const response = await client.shell.exec({ target: value.targetId, input: `tabs open --active '${destination.href.replace(/'/g, "'\\''")}'` });
      if (response.status !== "completed") throw new Error(response.status === "failed" ? response.error : "Browser command is still running");
      const { tab } = z.object({ tab: browserTab }).parse(JSON.parse(response.output.slice(response.output.indexOf("\n") + 1)));
      setTabs(previous => [...previous, tab]); setTabId(tab.id); setUrl(""); requestId.current = crypto.randomUUID();
    }); }}><input aria-label="Website address" placeholder="example.com" value={url} onInput={event => setUrl(event.currentTarget.value)} disabled={busy || !allowed} /><button type="submit" disabled={busy || !url.trim() || !allowed}>open website</button></form>}
    <div class="fleet-actions">
      <button type="button" class="fleet-text-action is-primary" disabled={!allowed || busy || !connected || instance?.state !== "ready"} onClick={() => void act(async value => {
        if (handoff) { open(handoff); return; }
        const result = await client.sys.browser.handoff.request({ instanceId: value.instanceId, tabId, requestId: requestId.current, purpose: "Sign in or use this browser" });
        requestId.current = crypto.randomUUID(); open(result.handoff);
      })}>use browser</button>
      <button type="button" class="fleet-text-action" disabled={!allowed || busy || !connected || !instance || instance.state === "stopping"} onClick={() => void act(async value => { await client.sys.instance.stop({ instanceId: value.instanceId }); })}>stop browser</button>
    </div>
    {error && <p class="error" role="alert">{error}</p>}
  </section>;
}
