import type { AiModelListEntry, AiModelsResult } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import type { ConsoleConfigEntry } from "../../gsv-console/domain/consoleModels";
import {
  editableModelSource,
  modelProfilesConfigKey,
  preferredModelSaveEntry,
  serializeModelProfiles,
  writableModelProfiles,
  type ConsoleConfigWrite,
} from "../../gsv-console/domain/consoleSettings";

export type ModelStackDraft = { ids: string[]; preferredId: string | null };
const storedLayerIdentitySchema = z.object({
  version: z.literal(1),
  models: z.array(z.object({ id: z.string() })).min(1),
});

function storedLayerIds(entry: ConsoleConfigEntry | undefined): string[] | null {
  if (!entry || entry.redacted) return null;
  try {
    const parsed = storedLayerIdentitySchema.safeParse(JSON.parse(entry.value));
    return parsed.success ? parsed.data.models.map((model) => model.id) : null;
  } catch {
    return null;
  }
}

export function configuredModelOrder(listing: AiModelsResult, uid: number): ModelStackDraft {
  return {
    ids: listing.models.filter((model) => model.source === editableModelSource(uid)).map((model) => model.id),
    preferredId: listing.preferredModelId,
  };
}

/** Display the order generation will try, keeping shared entries in their owning layer. */
export function orderedModels(listing: AiModelsResult, order: ModelStackDraft, uid: number): AiModelListEntry[] {
  const source = editableModelSource(uid);
  const own = listing.models.filter((model) => model.source === source);
  const byId = new Map(own.map((model) => [model.id, model]));
  const reordered = [
    ...order.ids.flatMap((id) => byId.get(id) ?? []),
    ...own.filter((model) => !order.ids.includes(model.id)),
  ];
  let index = 0;
  const next = listing.models.map((model) => model.source === source ? reordered[index++] : model);
  const first = next.findIndex((model) => model.id === order.preferredId);
  if (first > 0) next.unshift(...next.splice(first, 1));
  return next;
}

export function moveModel(listing: AiModelsResult, order: ModelStackDraft, uid: number, id: string, direction: -1 | 1): ModelStackDraft {
  const ids = orderedModels(listing, order, uid)
    .filter((model) => model.source === editableModelSource(uid)).map((model) => model.id);
  const at = ids.indexOf(id);
  return at < 0 ? order : moveModelTo(listing, order, uid, id, at + direction);
}

export function moveModelTo(listing: AiModelsResult, order: ModelStackDraft, uid: number, id: string, to: number): ModelStackDraft {
  const ids = orderedModels(listing, order, uid)
    .filter((model) => model.source === editableModelSource(uid)).map((model) => model.id);
  const at = ids.indexOf(id);
  if (at < 0 || to < 0 || to >= ids.length || to === at) return order;
  ids.splice(to, 0, ...ids.splice(at, 1));
  return { ids, preferredId: order.preferredId && ids.includes(order.preferredId) ? null : order.preferredId };
}

export function useModelFirst(listing: AiModelsResult, order: ModelStackDraft, uid: number, id: string): ModelStackDraft {
  const model = listing.models.find((entry) => entry.id === id);
  if (!model) throw new Error("This model is no longer available. Reload the model stack.");
  if (model.source !== editableModelSource(uid)) return { ...order, preferredId: id };
  const ids = orderedModels(listing, order, uid)
    .filter((entry) => entry.source === editableModelSource(uid)).map((entry) => entry.id);
  return { ids: [id, ...ids.filter((entry) => entry !== id)], preferredId: listing.models[0]?.source === model.source ? null : id };
}

/** An order edit writes only the list and its preference; credential keys retain their values. */
export function modelOrderWrites(listing: AiModelsResult, config: readonly ConsoleConfigEntry[], uid: number, order: ModelStackDraft): ConsoleConfigWrite[] {
  const profiles = writableModelProfiles(listing, config, uid);
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  if (order.ids.length !== profiles.length || new Set(order.ids).size !== profiles.length || order.ids.some((id) => !byId.has(id))) {
    throw new Error("Your model stack changed while you were editing. Discard these changes and try again.");
  }
  if (order.preferredId && !listing.models.some((model) => model.id === order.preferredId)) {
    throw new Error("Your first-choice model is no longer available. Choose another model.");
  }
  const writes: ConsoleConfigWrite[] = [];
  if (profiles.some((profile, index) => profile.id !== order.ids[index])) {
    const key = modelProfilesConfigKey(uid);
    const persistedIds = storedLayerIds(config.find((entry) => entry.key === key));
    if (!persistedIds || persistedIds.length !== profiles.length || profiles.some((profile, index) => profile.id !== persistedIds[index])) {
      throw new Error("The stored model layer differs from this listing. Reload it before changing its order; hidden models must be preserved.");
    }
    writes.push({ key, value: serializeModelProfiles(order.ids.map((id) => byId.get(id)!)) });
  }
  const preference = preferredModelSaveEntry(uid, order.preferredId);
  if ((config.find((entry) => entry.key === preference.key)?.value ?? "") !== preference.value) writes.push(preference);
  return writes;
}
