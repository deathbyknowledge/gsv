import type { AiModelsResult } from "@humansandmachines/gsv/protocol";
import type { ConsoleConfigEntry } from "../../../domain/system/consoleModels";
import {
  deleteModelProfile,
  editableModelSource,
  modelProfilesFromListing,
  modelProfileSaveEntries,
  normalizeProfileName,
  preferredModelSaveEntry,
  serializeModelProfiles,
  updateModelProfile,
  writableModelProfiles,
  type ConsoleConfigWrite,
  type ConsoleModelProfile,
} from "../../../domain/system/consoleSettings";

type ModelChange =
  | { kind: "edit"; name: string; values: Record<string, string>; clearApiKey: boolean }
  | { kind: "remove" };

/** A stored key can be reused only for the same connection that the gateway saved it against. */
export function modelConnectionChanged(before: Record<string, string>, after: Record<string, string>): boolean {
  const scope = (values: Record<string, string>) => {
    const text = (field: string) => values[`config/ai/${field}`]?.trim() ?? "";
    const target = text("transport_target");
    return [text("provider").toLowerCase(), text("model"), text("base_url"), text("provider_style").toLowerCase() || "auto", !target || target === "worker" ? "gsv" : target];
  };
  return JSON.stringify(scope(before)) !== JSON.stringify(scope(after));
}

/** Mutate one owned definition in its stored layer, leaving the other models and keys intact. */
export function modelProfileChangeWrites(
  listing: AiModelsResult,
  config: readonly ConsoleConfigEntry[],
  uid: number,
  original: ConsoleModelProfile,
  change: ModelChange,
): ConsoleConfigWrite[] {
  if (original.source !== editableModelSource(uid)) throw new Error("Inherited model definitions cannot be changed here.");
  const writable = writableModelProfiles(listing, config, uid).map((profile) => ({
    ...profile, values: { ...profile.values, "config/ai/api_key": "" },
  }));
  const current = writable.find((profile) => profile.id === original.id);
  if (!current || serializeModelProfiles([current]) !== serializeModelProfiles([original])) {
    throw new Error("This model changed while you were editing. Reopen it to see the latest settings.");
  }
  if (change.kind === "edit") {
    const name = normalizeProfileName(change.name);
    const reserved = [...writable, ...modelProfilesFromListing(listing, [], uid)];
    if (reserved.some((profile) => profile.id !== original.id && profile.name.toLowerCase() === name.toLowerCase())) {
      throw new Error("That name is already in your stack. Give this model a different name.");
    }
    return modelProfileSaveEntries(uid, updateModelProfile(writable, original.id, name, change.values),
      new Map([[original.id, new Set(change.clearApiKey ? ["config/ai/api_key"] : [])]]));
  }
  const entries = modelProfileSaveEntries(uid, deleteModelProfile(writable, original.id));
  const orderKey = `users/${uid}/ai/model_order`;
  const storedOrder = config.find((entry) => entry.key === orderKey)?.value;
  if (storedOrder) {
    const ids: string[] = JSON.parse(storedOrder);
    const remaining = ids.filter((id) => id !== original.id);
    if (remaining.length !== ids.length) entries.push({ key: orderKey, value: remaining.length ? JSON.stringify(remaining) : "" });
  }
  if (config.find((entry) => entry.key === `users/${uid}/ai/preferred_model`)?.value === original.id) {
    entries.push(preferredModelSaveEntry(uid, null));
  }
  return entries;
}
