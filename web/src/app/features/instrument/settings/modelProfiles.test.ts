import { describe, expect, it } from "vitest";
import type { AiModelListEntry, AiModelsResult } from "@humansandmachines/gsv/protocol";
import type { ConsoleConfigEntry } from "../../gsv-console/domain/consoleModels";
import { modelProfilesFromListing } from "../../gsv-console/domain/consoleSettings";
import { modelConnectionChanged, modelProfileChangeWrites } from "./modelProfiles";

const model = (id: string, source: AiModelListEntry["source"] = "personal"): AiModelListEntry => ({
  id, name: id, provider: "custom", model: `${id}-model`, source, hasCredential: true,
  baseUrl: "https://models.example.invalid/v1", providerStyle: "openai-chat-completions", transportTarget: "gsv",
  maxTokens: 8192, contextWindowTokens: 65536,
});
const listing: AiModelsResult = { models: [model("one"), model("two"), model("included", "base")], preferredModelId: null };
const original = modelProfilesFromListing(listing, [], 1000)[0];
const entry = (key: string, value: string): ConsoleConfigEntry => ({ key, value, redacted: false });
const stack = (models: AiModelListEntry[], uid = 1000) => entry(uid === 0 ? "config/ai/models" : `users/${uid}/ai/models`, JSON.stringify({
  version: 1, models: models.map(({ source: _source, hasCredential: _credential, ...definition }) => definition),
}));
const config = [stack(listing.models.slice(0, 2)), entry("users/1000/ai/models/one/api_key", "private-fixture-one"), entry("users/1000/ai/models/two/api_key", "private-fixture-two")];

describe("model definition changes", () => {
  it("edits one stable model ID without rewriting credentials, the other model or the fallback order", () => {
    const before = JSON.stringify(config);
    const writes = modelProfileChangeWrites(listing, config, 1000, original, { kind: "edit", name: "Renamed", values: original.values, clearApiKey: false });
    expect(writes).toHaveLength(1);
    expect(writes[0].key).toBe("users/1000/ai/models");
    const saved = JSON.parse(writes[0].value!);
    const old = JSON.parse(config[0].value);
    expect(saved.models).toEqual([{ ...old.models[0], name: "Renamed" }, old.models[1]]);
    expect(JSON.stringify(writes)).not.toContain("private-fixture");
    expect(JSON.stringify(config)).toBe(before);
  });

  it("writes only an explicitly replaced or cleared credential", () => {
    const replacement = modelProfileChangeWrites(listing, config, 1000, original, {
      kind: "edit", name: original.name, values: { ...original.values, "config/ai/api_key": "replacement-fixture" }, clearApiKey: false,
    });
    expect(replacement.slice(1)).toEqual([{ key: "users/1000/ai/models/one/api_key", value: "replacement-fixture" }]);
    const cleared = modelProfileChangeWrites(listing, config, 1000, original, { kind: "edit", name: original.name, values: original.values, clearApiKey: true });
    expect(cleared.slice(1)).toEqual([{ key: "users/1000/ai/models/one/api_key", value: "" }]);
  });

  it("removes one model and its ordering references, leaving gateway-owned credential cleanup to the stack write", () => {
    const writes = modelProfileChangeWrites(listing, [...config,
      entry("users/1000/ai/model_order", '["included","one","unavailable","two"]'),
      entry("users/1000/ai/preferred_model", "one"),
    ], 1000, original, { kind: "remove" });
    expect(JSON.parse(writes[0].value!).models.map((model: { id: string }) => model.id)).toEqual(["two"]);
    expect(writes.slice(1)).toEqual([
      { key: "users/1000/ai/model_order", value: '["included","unavailable","two"]' },
      { key: "users/1000/ai/preferred_model", value: "" },
    ]);
    expect(modelProfileChangeWrites({ ...listing, models: [listing.models[0], listing.models[2]] }, [stack([listing.models[0]])], 1000, original, { kind: "remove" })).toEqual([{ key: "users/1000/ai/models", value: "" }]);
  });

  it("preserves a hidden installation definition when root edits its visible sibling", () => {
    const visible = { ...listing, models: [model("one", "system"), model("included", "base")] };
    const rootOriginal = modelProfilesFromListing(visible, [], 0)[0];
    const stored = stack([model("hidden", "system"), visible.models[0]], 0);
    const writes = modelProfileChangeWrites(visible, [stored], 0, rootOriginal, { kind: "edit", name: "Renamed", values: rootOriginal.values, clearApiKey: false });
    expect(writes[0].key).toBe("config/ai/models");
    expect(JSON.parse(writes[0].value!).models[0]).toEqual(JSON.parse(stored.value).models[0]);
  });

  it("rejects inherited definitions, duplicate names and edits based on a changed or removed model", () => {
    const inherited = modelProfilesFromListing(listing, [], 1000)[2];
    expect(() => modelProfileChangeWrites(listing, config, 1000, inherited, { kind: "remove" })).toThrow("Inherited");
    expect(() => modelProfileChangeWrites(listing, config, 1000, original, { kind: "edit", name: "  INCLUDED ", values: original.values, clearApiKey: false })).toThrow("already in your stack");
    const changed = stack([{ ...listing.models[0], maxTokens: 2048 }, listing.models[1]]);
    expect(() => modelProfileChangeWrites(listing, [changed], 1000, original, { kind: "remove" })).toThrow("changed while you were editing");
    expect(() => modelProfileChangeWrites(listing, [stack([listing.models[1]])], 1000, original, { kind: "remove" })).toThrow("changed while you were editing");
  });

  it("keeps a credential for equivalent defaults but requires a new one when the connection changes", () => {
    const before = { ...original.values, "config/ai/provider_style": "", "config/ai/transport_target": "" };
    expect(modelConnectionChanged(before, { ...before, "config/ai/provider": " CUSTOM ", "config/ai/provider_style": "auto", "config/ai/transport_target": "worker", "config/ai/max_tokens": "4096" })).toBe(false);
    for (const field of ["provider", "model", "base_url", "provider_style", "transport_target"]) {
      expect(modelConnectionChanged(before, { ...before, [`config/ai/${field}`]: "changed" })).toBe(true);
    }
  });
});
