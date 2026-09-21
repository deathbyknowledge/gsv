import type { JsonObject } from "./json";
import type { ActorRef } from "./social";
import type { ContactRequestState } from "./syscalls/contact";

export type WorkParticipant = "requester" | "performer";
export type WorkAction = "withdraw" | "accept" | "reject" | "start" | "complete" | "cancel" | "acknowledge" | "dispute";
export type WorkOffer = {
  reference: { actor: ActorRef; id: string };
  kind: string;
  title: string;
  details?: JsonObject;
  createdAtMs: number;
};
export type WorkOperation = {
  id: string;
  revision: number;
  action: WorkAction;
  observedPeerRevision: number;
  note?: string;
};
export type WorkRecord = { offer: WorkOffer; requester: WorkOperation[]; performer: WorkOperation[] };
export type FederationWorkDelivery = {
  kind: "work";
  offer: WorkOffer;
  participant: WorkParticipant;
  operations: WorkOperation[];
};
export type WorkProjection = {
  state: ContactRequestState;
  status: ContactRequestState | "withdrawn" | "stop_requested";
  outcome: "unreviewed" | "acknowledged" | "disputed";
};

export function projectWork(work: WorkRecord): WorkProjection {
  const performer = work.performer.at(-1)?.action;
  const requester = work.requester.at(-1)?.action;
  const withdrawn = work.requester.some((operation) => operation.action === "withdraw");
  const state = performer === "accept" ? "accepted" : performer === "start" ? "active"
    : performer === "complete" ? "completed" : performer === "reject" ? "rejected"
      : performer === "cancel" ? "cancelled" : "offered";
  return {
    state,
    status: withdrawn && state === "offered" ? "withdrawn"
      : withdrawn && (state === "accepted" || state === "active") ? "stop_requested" : state,
    outcome: requester === "acknowledge" ? "acknowledged" : requester === "dispute" ? "disputed" : "unreviewed",
  };
}

export function workActions(work: WorkRecord, participant: WorkParticipant): WorkAction[] {
  const own = work[participant];
  const previous = own.at(-1)?.action;
  const projection = projectWork(work);
  if (participant === "requester") {
    if (projection.state === "completed") {
      return previous === "acknowledge" ? [] : previous === "dispute" ? ["acknowledge"] : ["acknowledge", "dispute"];
    }
    return !own.length && ["offered", "accepted", "active"].includes(projection.state) ? ["withdraw"] : [];
  }
  if (["complete", "reject", "cancel"].includes(previous ?? "")) return [];
  const withdrawn = work.requester.some((operation) => operation.action === "withdraw");
  if (!previous) return withdrawn ? ["reject", "cancel"] : ["accept", "reject"];
  if (previous === "accept") return withdrawn ? ["complete", "cancel"] : ["start", "complete", "cancel"];
  return previous === "start" ? ["complete", "cancel"] : [];
}

/** Each sender carries its entire bounded stream, so a later delivery repairs a missing prefix. */
export function mergeWorkStream(work: WorkRecord, participant: WorkParticipant, incoming: WorkOperation[]): WorkRecord {
  if (incoming.length > 8) throw new Error("Work operation limit reached");
  const previous = work[participant];
  const peer: WorkParticipant = participant === "requester" ? "performer" : "requester";
  const ids = new Set<string>();
  for (let index = 0; index < incoming.length; index += 1) {
    const operation = incoming[index];
    if (operation.revision !== index + 1 || ids.has(operation.id)) throw new Error("Work stream is not a contiguous unique prefix");
    ids.add(operation.id);
    const saved = previous[index];
    if (saved && (saved.id !== operation.id || saved.action !== operation.action
      || saved.observedPeerRevision !== operation.observedPeerRevision || saved.note !== operation.note)) {
      throw new Error("Work operation identity was reused");
    }
    if (saved) continue;
    if (operation.observedPeerRevision > work[peer].length || operation.observedPeerRevision < 0
      || operation.observedPeerRevision < (incoming[index - 1]?.observedPeerRevision ?? 0)) {
      throw new Error("Work operation has an unavailable causal reference");
    }
    const causalView: WorkRecord = { ...work, [participant]: incoming.slice(0, index), [peer]: work[peer].slice(0, operation.observedPeerRevision) };
    if (!workActions(causalView, participant).includes(operation.action)) throw new Error("Work participant cannot make this statement");
  }
  return incoming.length > previous.length ? { ...work, [participant]: incoming } : work;
}
