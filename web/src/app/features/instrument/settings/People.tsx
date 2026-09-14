import { useQuery, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { createHumanInvitation } from "../../../services/system/peopleService";
import { SettingsError, useSettingsDirty, type SettingsSectionProps } from "./settingsShared";

const peopleKey = ["settings", "people"];
const invitesKey = ["settings", "human-invitations"];

export function People({ account, active, onDirty }: SettingsSectionProps) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const allowed = account.uid === 0;
  const people = useQuery({ queryKey: peopleKey, queryFn: () => client.account.people.list({}), enabled: allowed && connected && active });
  const invitations = useQuery({ queryKey: invitesKey, queryFn: () => client.account.invite.list({}), enabled: allowed && connected && active });
  const [username, setUsername] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ uid: number; action: "password" | "remove" } | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useSettingsDirty(Boolean(username || password || busy), onDirty);
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null);
    try { await work(); }
    catch (cause) { setError(cause instanceof Error ? cause : new Error("People update failed")); }
    finally {
      setBusy(false);
      await Promise.all([cache.invalidateQueries({ queryKey: peopleKey }), cache.invalidateQueries({ queryKey: invitesKey })]);
    }
  };
  if (!allowed) return <p>Sign in as root to manage people in this space.</p>;
  const editable = connected && !busy;
  return <section aria-labelledby="settings-people-title"><h1 id="settings-people-title">People</h1>
    <p class="settings-intro">Root invites people and manages their access to this space.</p>
    <SettingsError error={error ?? people.error ?? invitations.error} />
    {notice && <p role="status">{notice}</p>}
    <form class="settings-form" aria-label="Invite a person" onSubmit={(event) => { event.preventDefault(); void run(async () => { setLink(await createHumanInvitation(client, username)); setUsername(""); }); }}>
      <h2>Invite a person</h2>
      <label>Username<input value={username} required pattern="[a-z_][a-z0-9_-]{0,31}" maxLength={32} disabled={!editable}
        onInput={(event) => { setUsername(event.currentTarget.value); setLink(null); }} /></label>
      <button class="ibtn" type="submit" disabled={!editable || !username}>create invitation</button>
      {link && <div><p>Share this private link with the person. It expires after ten minutes.</p>
        <input aria-label="Private invitation link" readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
        <button class="settings-text-action" type="button" onClick={() => void run(async () => { await navigator.clipboard.writeText(link); setNotice("Invitation copied."); })}>copy link</button>
      </div>}
    </form>
    <h2>Accounts</h2>
    {people.data?.people.map((person) => <div class="settings-form" key={person.uid}>
      <strong>{person.displayName}</strong><span class="settings-muted"> {person.username}{person.uid === 0 ? " · root" : person.disabled ? " · removed" : ""}</span>
      {person.uid !== 0 && !person.disabled && (selected?.uid === person.uid ? <div>
        {selected.action === "password" ? <form onSubmit={(event) => { event.preventDefault(); void run(async () => {
          await client.account.password.set({ uid: person.uid, password }); setPassword(""); setSelected(null); setNotice(`Password changed for ${person.username}.`);
        }); }}>
          <p>Set a new password for {person.username}. Existing credentials and messenger links will be revoked.</p>
          <label>New password<input type="password" autoComplete="new-password" minLength={8} maxLength={1024} value={password} disabled={!editable} onInput={(event) => setPassword(event.currentTarget.value)} /></label>
          <button class="ibtn" type="submit" disabled={!editable || password.length < 8}>set password</button>
        </form> : <><p>Remove {person.username} from this space? Their credentials and messenger links will stop working. Their data and work already running remain.</p>
          <button class="settings-text-action settings-danger" type="button" disabled={!editable} onClick={() => void run(async () => { await client.account.remove({ uid: person.uid }); setSelected(null); setNotice(`${person.username} removed.`); })}>remove access</button></>}
        <button class="settings-text-action" type="button" disabled={!editable} onClick={() => { setSelected(null); setPassword(""); }}>cancel</button>
      </div> : <div class="settings-actions">
        <button class="settings-text-action" type="button" disabled={!editable} onClick={() => { setSelected({ uid: person.uid, action: "password" }); setPassword(""); }}>set password</button>
        <button class="settings-text-action" type="button" disabled={!editable} onClick={() => { setSelected({ uid: person.uid, action: "remove" }); setPassword(""); }}>remove access</button>
      </div>)}
    </div>)}
    <h2>Invitations</h2>
    {invitations.data?.invitations.length === 0 && <p>No invitations.</p>}
    {invitations.data?.invitations.map((invitation) => <p key={invitation.id}>{invitation.username} · {invitation.status} {invitation.status === "pending" && <button class="settings-text-action" type="button" disabled={!editable}
      onClick={() => void run(async () => { await client.account.invite.cancel({ id: invitation.id }); setLink(null); })}>cancel invitation</button>}</p>)}
  </section>;
}
