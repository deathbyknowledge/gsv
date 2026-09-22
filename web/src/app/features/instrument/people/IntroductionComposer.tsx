import { useInfiniteQuery, useMutation } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { contactDisplayName, type ContactListArgs, type ContactSendResult, type ContactSummary, type PublicProfile } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { useDraftGuard } from "../shared/useDraftGuard";
import { INSTRUMENT_CONTACTS_KEY } from "../wire/queryKeys";
import { introductionReview, type IntroductionPart, type IntroductionPlan, type IntroductionReview } from "./introductions";

const FIRST: ContactListArgs["after"] = undefined;

export function IntroductionComposer({ plan, account, onClose, onDirty, onOpen }: {
  plan: IntroductionPlan; account: ConsoleAccount | undefined; onClose: () => void; onDirty: (dirty: boolean) => void; onOpen: (id: string) => void;
}) {
  const { client, connected } = useGateway();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ContactSummary | undefined>();
  const [name, setName] = useState(plan.kind === "request" ? plan.label : "");
  const [recipientName, setRecipientName] = useState("");
  const [context, setContext] = useState("");
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [profile, setProfile] = useState<PublicProfile | undefined>();
  const [review, setReview] = useState<IntroductionReview | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [completed, setCompleted] = useState<Record<string, ContactSendResult>>({});
  const [error, setError] = useState("");
  const allowed = (name: string) => connected && !!account && account.uid >= 1000 && canConfigure(account, name);
  const contacts = useInfiniteQuery({ queryKey: [...INSTRUMENT_CONTACTS_KEY, "introduction", query], enabled: plan.kind !== "request" && allowed("contact.list"),
    initialPageParam: FIRST, queryFn: ({ pageParam }) => client.contact.list({ query: query.trim(), after: pageParam, limit: 30 }), getNextPageParam: (page) => page.next });
  const excluded = plan.kind === "offer" ? plan.person.id : plan.kind === "forward" ? plan.recipient.id : "";
  const choices = contacts.data?.pages.flatMap((page) => page.contacts).filter((contact) => contact.id !== excluded && contact.state === "active") ?? [];
  const resolve = useMutation({ mutationFn: (contact: ContactSummary) => client.profile.resolve({ contactId: contact.id }), onSuccess: ({ profile }) => { setProfile(profile); if (!name.trim()) setName(profile.displayName); } });
  const send = useMutation({ mutationFn: (part: IntroductionPart) => client.contact.send(part.args), onSuccess: (result, part) => setCompleted((previous) => ({ ...previous, [part.recipient.id]: result })) });
  const done = !!review && review.parts.every((part) => !!completed[part.recipient.id]);
  useDraftGuard(!done, onDirty);
  const prepare = () => {
    try { setReview(introductionReview({ plan, selected, name, recipientName, context, consentConfirmed, profile })); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Review the introduction details."); }
  };
  return <section class="people-context-editor" aria-label="Prepare an introduction">
    <div class="people-kicker">One conversation at a time</div><h2>{plan.kind === "request" ? "Ask for an introduction" : plan.kind === "offer" ? "Ask before introducing" : "Make the agreed introduction"}</h2>
    <p class="people-note">Introductions are ordinary messages in separate conversations. Each person chooses whether to continue.</p>
    {!review ? <form onSubmit={(event) => { event.preventDefault(); prepare(); }}>
      {plan.kind === "request" ? <p>To {contactDisplayName(plan.source)}</p> : <>
        <label>{plan.kind === "offer" ? "Who would you like to ask?" : "Who are you introducing?"}<input value={query} disabled={resolve.isPending} placeholder="Find an existing conversation…" onInput={(event) => setQuery(event.currentTarget.value)} /></label>
        <ul class="people-recipient-list">{choices.map((contact) => <li key={contact.id}><button type="button" class="people-recipient" aria-pressed={selected?.id === contact.id} disabled={resolve.isPending} onClick={() => { setSelected(contact); setProfile(undefined); }}><strong>{contactDisplayName(contact)}</strong><span>{contact.remoteOrigin}</span></button></li>)}</ul>
        {contacts.hasNextPage && <button type="button" class="people-action" disabled={contacts.isFetchingNextPage} onClick={() => void contacts.fetchNextPage()}>more conversations</button>}
        {selected && <p class="people-note">Selected: {contactDisplayName(selected)} · {selected.remoteOrigin}</p>}
      </>}
      <label>Name to use for the person being introduced<input value={name} maxLength={80} required onInput={(event) => setName(event.currentTarget.value)} /></label>
      {plan.kind === "forward" && <>
        <p class="people-note">Recipient's selected response, {new Date(plan.consent.createdAt).toLocaleString()}:</p><blockquote>{plan.consent.text}</blockquote>
        <label>Name the recipient agreed to share<input value={recipientName} maxLength={80} required onInput={(event) => setRecipientName(event.currentTarget.value)} /></label>
        <label class="people-check"><input type="checkbox" checked={consentConfirmed} required onChange={(event) => setConsentConfirmed(event.currentTarget.checked)} />I have agreed with both people that they want this introduction and what I may share.</label>
        {selected && <div class="people-actions"><button type="button" class="people-action" disabled={!allowed("profile.resolve") || resolve.isPending} onClick={() => resolve.mutate(selected)}>{resolve.isPending ? "looking up their profile…" : "include their published profile"}</button></div>}
        {profile && <p class="people-note">Included public profile: <a href={profile.url} target="_blank" rel="noreferrer">{profile.url}</a> <button type="button" class="people-action" onClick={() => setProfile(undefined)}>remove</button></p>}
      </>}
      <label>{plan.kind === "forward" ? "The selected context to share with both people" : "A brief reason (optional)"}<textarea rows={4} value={context} maxLength={4000} onInput={(event) => setContext(event.currentTarget.value)} /></label>
      <p class="people-note">{plan.kind === "forward" ? "Only the words and optional public profile shown in the next review will be sent. Your selected response, other messages and attachments are kept private." : "Keep this initial request brief. Agree permission before forwarding private context."}</p>
      <button class="ibtn" type="submit" disabled={!allowed("contact.send") || resolve.isPending}>review messages</button>
    </form> : <>
      {review.parts.map((part, index) => {
        const result = completed[part.recipient.id];
        return <article class="people-introduction-message" key={part.recipient.id}><h3>{part.title}</h3><p class="people-note">To {contactDisplayName(part.recipient)} · {part.recipient.remoteOrigin}</p><pre class="people-evidence-preview">{part.args.text}</pre>
          {result ? <div role="status"><p>{result.state === "delivered" ? "Received by their GSV." : result.state === "queued" ? "Saved and queued for delivery." : "Saved, but delivery failed. Open the conversation to inspect or retry it."}</p><button class="people-action" onClick={() => onOpen(part.recipient.id)}>open conversation</button></div>
            : <button class="ibtn is-primary" disabled={!allowed("contact.send") || send.isPending || index > 0 && !completed[review.parts[index - 1].recipient.id]} onClick={() => { setAttempted(true); send.mutate(part); }}>{send.isPending && send.variables?.recipient.id === part.recipient.id ? "sending…" : send.isError && send.variables?.recipient.id === part.recipient.id ? "retry this exact message" : "send this message"}</button>}
        </article>;
      })}
      {!attempted && <button class="people-action" onClick={() => setReview(null)}>back to editing</button>}
      {done && plan.kind === "offer" && <p class="people-note">Wait for their response. When the details are agreed with both people, select the recipient's reply in the conversation and choose “make an agreed introduction”.</p>}
    </>}
    {(error || contacts.error || resolve.error || send.error) && <p class="people-error" role="alert">{error || contacts.error?.message || resolve.error?.message || send.error?.message}</p>}
    <button class="people-action" disabled={send.isPending || resolve.isPending} onClick={onClose}>{done ? "done" : attempted ? "close" : "cancel"}</button>
  </section>;
}
