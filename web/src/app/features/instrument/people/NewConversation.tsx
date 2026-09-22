import type { ApproachCreateArgs, ApproachSummary } from "@humansandmachines/gsv/protocol";
import { useMutation, useQuery } from "@tanstack/preact-query";
import { useEffect, useRef } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { LoadingState } from "../../../components/ui/Spinner";
import { INSTRUMENT_CONTACTS_KEY } from "../wire/queryKeys";
import { approachSendIntent, type ApproachDraft } from "./peopleModel";
import { PublicProfileImage } from "./PublicProfileImage";

export function NewConversation({ account, draft, onChange, onSent, onBusy, onOpen, onInvitation }: {
  account: ConsoleAccount | undefined;
  draft: ApproachDraft;
  onChange: (value: ApproachDraft) => void;
  onSent: (request: ApproachSummary) => void;
  onBusy: (busy: boolean) => void;
  onOpen: (contactId: string) => void;
  onInvitation: () => void;
}) {
  const { client, connected } = useGateway();
  const resolve = useMutation({
    mutationFn: (url: string) => client.profile.resolve({ url }),
    onSuccess: ({ profile }) => onChange({ ...draft, profile, url: profile.url }),
  });
  const send = useMutation({
    mutationFn: (intent: ApproachCreateArgs) => client.approach.create(intent),
    onSuccess: ({ approach }) => onSent(approach),
  });
  const initial = useRef(false);
  useEffect(() => {
    if (initial.current || !connected || !account) return;
    initial.current = true;
    if (draft.url && !draft.profile && canConfigure(account, "profile.resolve")) resolve.mutate(draft.url);
  }, [connected, account]);
  const busy = resolve.isPending || send.isPending;
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  const profile = draft.profile;
  const known = useQuery({
    queryKey: [...INSTRUMENT_CONTACTS_KEY, "actor", profile?.actor],
    enabled: connected && !!profile && !!account && canConfigure(account, "contact.list"),
    queryFn: () => client.contact.list({ actor: profile!.actor, limit: 1 }),
  });
  const existing = known.data?.contacts[0];
  const canResolve = connected && !!account && canConfigure(account, "profile.resolve");
  const canSend = connected && !!account && canConfigure(account, "approach.create");
  const bytes = new TextEncoder().encode(draft.text.trim()).length;
  const valid = !!draft.displayName.trim() && !!draft.text.trim() && bytes <= 32_768;
  const error = resolve.error ?? send.error ?? known.error;

  return <section class="people-compose" aria-labelledby="new-conversation-title">
    <div class="people-kicker">New conversation</div><h1 id="new-conversation-title">Who would you like to talk to?</h1>
    <p class="people-note">Open their public profile to send a message request.</p>
    <form class="people-form" onSubmit={(event) => {
      event.preventDefault();
      if (canResolve && draft.url.trim() && !busy) resolve.mutate(draft.url.trim());
    }}>
      <label>Profile address<input type="url" value={draft.url} placeholder="https://their-space.gsv.space/@name" spellcheck={false} autoComplete="url" disabled={!canResolve || busy} onInput={(event) => {
        resolve.reset(); send.reset(); onChange({ ...draft, url: event.currentTarget.value, profile: null });
      }} /></label>
      <button class="people-action" type="submit" disabled={!canResolve || busy || !draft.url.trim()}>{resolve.isPending ? <LoadingState>opening profile…</LoadingState> : "open profile"}</button>
    </form>
    {profile && <>
      <div class="people-profile-preview">
        {account && canConfigure(account, "profile.avatar.read") && <PublicProfileImage profile={profile} />}
        <span class="people-kicker">@{profile.alias} · {new URL(profile.origin).host}</span>
        <h2>{profile.displayName}</h2>{profile.about && <p>{profile.about}</p>}
        <p class="people-note">{profile.representation === "human-and-ship" ? "They may reply personally or through their Ship. Messages show who sent them." : "A personal profile."}</p>
      </div>
      {known.isFetching ? <LoadingState>Checking your existing conversation…</LoadingState> : existing ? <button class="ibtn is-primary" onClick={() => onOpen(existing.id)}>open your conversation</button>
        : profile.contactPolicy !== "requests" ? <p class="people-note">{profile.contactPolicy === "invitation" ? "This person connects by private invitation." : "This person is not receiving new message requests."}</p>
        : <form class="people-form" onSubmit={(event) => {
          event.preventDefault();
          if (!canSend || !valid || busy) return;
          const intent = approachSendIntent(draft);
          onChange({ ...draft, intent }); send.mutate(intent);
        }}>
          <label>Your name for this conversation<input value={draft.displayName} maxLength={80} autoComplete="off" placeholder="The name you want them to see" disabled={busy} onInput={(event) => onChange({ ...draft, displayName: event.currentTarget.value })} /></label>
          <p class="people-note">This name and your message will be shared. Your sign-in name stays private.</p>
          <label>Your first message<textarea value={draft.text} rows={7} maxLength={32_768} placeholder="Say hello, ask a question, or explain why you’re reaching out." disabled={busy} onInput={(event) => onChange({ ...draft, text: event.currentTarget.value })} /></label>
          {bytes > 32_768 && <p class="people-error" role="alert">This message is too long. Shorten it before sending.</p>}
          <p class="people-note">One message to start. You can send more and share attachments after they accept.</p>
          <button class="ibtn is-primary" type="submit" disabled={!canSend || busy || !valid}>{send.isPending ? <LoadingState>sending request…</LoadingState> : "send message request"}</button>
        </form>}
    </>}
    {account && !canConfigure(account, "approach.create") && <p class="people-note">This account can review profiles but cannot send message requests.</p>}
    {error && <p class="people-error" role="alert">{error.message}</p>}
    {!connected && <p class="people-note" role="status">Reconnecting… Your draft is kept here.</p>}
    <div class="people-compose-footer"><span>Have a pairing code, or want to invite someone privately?</span><button class="people-action" disabled={busy} onClick={onInvitation}>use an invitation</button></div>
  </section>;
}
