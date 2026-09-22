import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import type { ContactRequestActArgs, ContactRequestCreateArgs, ContactRequestRecord, ContactSummary, WorkAction } from "@humansandmachines/gsv/protocol";
import { contactDisplayName } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { LoadingState } from "../../../components/ui/Spinner";
import { useDraftGuard } from "../shared/useDraftGuard";
import { instrumentContactRequestsKey } from "../wire/queryKeys";
import { refreshContactQuery } from "../wire/contactSync";
import { WORK_EXPLANATIONS, WORK_LABELS } from "./WorkRequestRow";

export type WorkEditorSelection = { kind: "offer" } | { kind: "action"; request: ContactRequestRecord; action: WorkAction | "reconcile" };
type WorkIntent = { kind: "offer"; args: ContactRequestCreateArgs } | { kind: "action"; args: ContactRequestActArgs };

export function WorkRequestEditor({ selection, contact, currentRevision, allowed, onClose, onDirty }: {
  selection: WorkEditorSelection; contact: ContactSummary; currentRevision?: number; allowed: boolean;
  onClose: () => void; onDirty: (dirty: boolean) => void;
}) {
  const { client } = useGateway();
  const cache = useQueryClient();
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [intent, setIntent] = useState<WorkIntent | null>(null);
  const mutation = useMutation({
    mutationFn: (value: WorkIntent) => value.kind === "offer" ? client.contact.request.create(value.args) : client.contact.request.act(value.args),
    onSuccess: async () => { await refreshContactQuery(cache, instrumentContactRequestsKey(contact.id)); onClose(); },
    onError: () => refreshContactQuery(cache, instrumentContactRequestsKey(contact.id)),
  });
  useDraftGuard(true, onDirty);
  const changed = selection.kind === "action" && currentRevision !== selection.request.revision;
  const noteTooLong = new TextEncoder().encode(note).length > (selection.kind === "offer" ? 28 * 1024 : 1024);
  const valid = !noteTooLong && (selection.kind !== "offer" || !!title.trim()) && (intent || !changed);
  const submit = () => {
    if (!allowed || !valid || mutation.isPending) return;
    const next: WorkIntent = intent ?? (selection.kind === "offer" ? { kind: "offer", args: {
      contactId: contact.id, expectedGeneration: contact.generation, kind: "task", title: title.trim(),
      ...(note.trim() ? { details: { description: note.trim() } } : undefined), idempotencyKey: crypto.randomUUID(),
    } } : { kind: "action", args: { requestId: selection.request.id, expectedRevision: selection.request.revision,
      action: selection.action, ...(note.trim() ? { note: note.trim() } : undefined), idempotencyKey: crypto.randomUUID() } });
    setIntent(next); mutation.mutate(next);
  };
  return <form class="people-work-editor" onSubmit={(event) => { event.preventDefault(); submit(); }}>
    <h4>{selection.kind === "offer" ? `Offer work to ${contactDisplayName(contact)}` : WORK_LABELS[selection.action]}</h4>
    <p class="note">{selection.kind === "offer" ? "Describe the result you are asking for. They choose whether to accept; sending an offer does not grant access to either space. Your Ship will track this request."
      : WORK_EXPLANATIONS[selection.action]}</p>
    {selection.kind === "offer" && <label>Requested result<input autoFocus value={title} maxLength={240} disabled={!!intent} onInput={(event) => setTitle(event.currentTarget.value)} required /></label>}
    {(selection.kind === "offer" || selection.action !== "reconcile") && <label>{selection.kind === "offer" ? "Details (optional)" : "Note to the other person (optional)"}
      <textarea autoFocus={selection.kind === "action"} rows={4} value={note} disabled={!!intent} maxLength={selection.kind === "offer" ? 7000 : 1024} onInput={(event) => setNote(event.currentTarget.value)} />
    </label>}
    {noteTooLong && <p class="error">Shorten the note before sending.</p>}
    {changed && !intent && <p class="note" role="status">This request changed while you were reviewing it. Close this form, read the latest statements, then choose your action again.</p>}
    {mutation.error && <p class="error" role="alert">{mutation.error.message} Your reviewed update is preserved for an exact retry.</p>}
    <div class="people-actions"><button class="ibtn" type="submit" disabled={!allowed || !valid || mutation.isPending}>{mutation.isPending ? <LoadingState>sending…</LoadingState>
      : intent ? "retry this update" : selection.kind === "offer" ? "send offer" : WORK_LABELS[selection.action]}</button>
      <button class="fleet-text-action" type="button" disabled={mutation.isPending} onClick={onClose}>{intent ? "close" : "cancel"}</button></div>
  </form>;
}
