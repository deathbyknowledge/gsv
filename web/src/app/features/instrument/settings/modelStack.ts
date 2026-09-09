import { orderAiModelIds, type AiModelListEntry, type AiModelsResult } from "@humansandmachines/gsv/protocol";
import type { ConsoleConfigEntry } from "../../gsv-console/domain/consoleModels";
import { preferredModelSaveEntry, type ConsoleConfigWrite } from "../../gsv-console/domain/consoleSettings";

export type ModelStackDraft = { ids: string[]; customized: boolean };

export function configuredModelOrder(listing: AiModelsResult): ModelStackDraft {
  return {
    ids: orderAiModelIds(listing.models.map((model) => model.id), listing.modelOrder, listing.preferredModelId),
    customized: listing.modelOrder !== undefined || listing.preferredModelId !== null,
  };
}

/** Display the order generation will try, keeping shared entries in their owning layer. */
export function orderedModels(listing: AiModelsResult, order: ModelStackDraft): AiModelListEntry[] {
  const byId = new Map(listing.models.map((model) => [model.id, model]));
  return orderAiModelIds([...byId.keys()], order.ids).map((id) => byId.get(id)!);
}

export function moveModel(listing: AiModelsResult, order: ModelStackDraft, id: string, direction: -1 | 1): ModelStackDraft {
  const at = orderedModels(listing, order).findIndex((model) => model.id === id);
  return at < 0 ? order : moveModelTo(listing, order, id, at + direction);
}

export function moveModelTo(listing: AiModelsResult, order: ModelStackDraft, id: string, to: number): ModelStackDraft {
  const ids = orderedModels(listing, order).map((model) => model.id);
  const at = ids.indexOf(id);
  if (at < 0 || to < 0 || to >= ids.length || to === at) return order;
  ids.splice(to, 0, ...ids.splice(at, 1));
  return { ids, customized: true };
}

export function useModelFirst(listing: AiModelsResult, order: ModelStackDraft, id: string): ModelStackDraft {
  return moveModelTo(listing, order, id, 0);
}

/** An order edit writes only the list and its preference; credential keys retain their values. */
export function modelOrderWrites(listing: AiModelsResult, config: readonly ConsoleConfigEntry[], uid: number, order: ModelStackDraft): ConsoleConfigWrite[] {
  const available = new Set(listing.models.map((model) => model.id));
  if (order.ids.length !== available.size || new Set(order.ids).size !== available.size || order.ids.some((id) => !available.has(id))) {
    throw new Error("Your model stack changed while you were editing. Discard these changes and try again.");
  }
  const writes = [
    { key: `users/${uid}/ai/model_order`, value: order.customized ? JSON.stringify(order.ids) : "" },
    preferredModelSaveEntry(uid, null),
  ];
  return writes.filter((write) => (config.find((entry) => entry.key === write.key)?.value ?? "") !== write.value);
}
