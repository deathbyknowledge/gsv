import { describe, expect, it } from "vitest";
import type { AiModelListEntry, AiModelsResult } from "@humansandmachines/gsv/protocol";
import type { ConsoleConfigEntry } from "../../gsv-console/domain/consoleModels";
import { configuredModelOrder, modelOrderWrites, moveModel, moveModelTo, orderedModels, useModelFirst } from "./modelStack";

const model = (id: string, source: AiModelListEntry["source"] = "personal"): AiModelListEntry => ({
  id, name: id, provider: "custom", model: `${id}-model`, source, hasCredential: true,
  baseUrl: "https://models.example.invalid/v1", providerStyle: "openai-chat-completions", transportTarget: "gsv",
  maxTokens: 8192, contextWindowTokens: 65536,
});
const listing = (preferredModelId: string | null = null): AiModelsResult => ({
  models: [model("one"), model("two"), model("three"), model("shared", "system"), model("included", "base")], preferredModelId,
});
const storedLayer = (models: AiModelsResult, uid = 1000): ConsoleConfigEntry => ({
  key: uid === 0 ? "config/ai/models" : `users/${uid}/ai/models`,
  value: JSON.stringify({ version: 1, models: models.models.filter((entry) => entry.source === (uid === 0 ? "system" : "personal")).map(({ source: _source, hasCredential: _credential, ...entry }) => entry) }),
  redacted: false,
});

describe("Settings model order", () => {
  it("drags across several owned entries without rewriting shared order or credentials", () => {
    const models = listing("shared");
    const order = configuredModelOrder(models, 1000);
    const moved = moveModelTo(models, order, 1000, "three", 0);
    expect(orderedModels(models, moved, 1000).map((entry) => entry.id)).toEqual(["shared", "three", "one", "two", "included"]);
    expect(moveModelTo(models, moved, 1000, "shared", 0)).toBe(moved);
    expect(moveModelTo(models, moved, 1000, "one", 4)).toBe(moved);
    const writes = modelOrderWrites(models, [storedLayer(models), { key: "users/1000/ai/preferred_model", value: "shared", redacted: false }], 1000, moved);
    expect(writes.map((entry) => entry.key)).toEqual(["users/1000/ai/models"]);
  });

  it("shows the selected model first and preserves the fallback sequence without changing stored order", () => {
    const models = listing("three");
    const order = configuredModelOrder(models, 1000);
    expect(order.ids).toEqual(["one", "two", "three"]);
    expect(orderedModels(models, order, 1000).map((entry) => entry.id)).toEqual(["three", "one", "two", "shared", "included"]);
    expect(models.models.map((entry) => entry.id)).toEqual(["one", "two", "three", "shared", "included"]);
  });

  it("moves the displayed personal preference into durable order so moving it down takes effect", () => {
    const models = listing("three");
    const next = moveModel(models, configuredModelOrder(models, 1000), 1000, "three", 1);
    expect(next).toEqual({ ids: ["one", "three", "two"], preferredId: null });
    const writes = modelOrderWrites(models, [storedLayer(models), { key: "users/1000/ai/preferred_model", value: "three", redacted: false }], 1000, next);
    expect(writes.map((entry) => entry.key)).toEqual(["users/1000/ai/models", "users/1000/ai/preferred_model"]);
    expect(writes[1].value).toBe("");
  });

  it("reorders personal fallbacks while retaining a shared first choice", () => {
    const models = listing("shared");
    const next = moveModel(models, configuredModelOrder(models, 1000), 1000, "two", -1);
    expect(orderedModels(models, next, 1000).map((entry) => entry.id)).toEqual(["shared", "two", "one", "three", "included"]);
    expect(moveModel(models, next, 1000, "shared", 1)).toBe(next);
  });

  it("promotes an included model without copying it into the personal stack", () => {
    const models = listing();
    const next = useModelFirst(models, configuredModelOrder(models, 1000), 1000, "included");
    expect(modelOrderWrites(models, [], 1000, next)).toEqual([{ key: "users/1000/ai/preferred_model", value: "included" }]);
    expect(orderedModels(models, next, 1000).map((entry) => entry.id)).toEqual(["included", "one", "two", "three", "shared"]);
  });

  it("preserves connection settings and never rewrites credential keys during an order edit", () => {
    const models = listing();
    const config = [storedLayer(models), { key: "users/1000/ai/models/two/api_key", value: "private-fixture", redacted: false }];
    const next = useModelFirst(models, configuredModelOrder(models, 1000), 1000, "two");
    const writes = modelOrderWrites(models, config, 1000, next);
    expect(writes).toHaveLength(1);
    expect(writes[0].key).toBe("users/1000/ai/models");
    // SAFETY: the preceding assertions establish the sole model-list write, which always carries its serialized value.
    const stored = JSON.parse(writes[0].value!);
    expect(stored.models.map((entry: { id: string }) => entry.id)).toEqual(["two", "one", "three"]);
    expect(stored.models[0]).toEqual({ id: "two", name: "two", provider: "custom", model: "two-model", baseUrl: "https://models.example.invalid/v1", providerStyle: "openai-chat-completions", transportTarget: "gsv", maxTokens: 8192, contextWindowTokens: 65536 });
    expect(writes[0].value).not.toContain("private-fixture");
    expect(writes[0].value).not.toContain("apiKey");
  });

  it("refuses a stale draft when the owned models have been added, removed, or duplicated", () => {
    const models = listing();
    for (const ids of [["one", "two"], ["one", "two", "missing"], ["one", "two", "two"]]) {
      expect(() => modelOrderWrites(models, [], 1000, { ids, preferredId: null })).toThrow("changed while you were editing");
    }
    expect(() => modelOrderWrites(models, [], 1000, { ids: ["one", "two", "three"], preferredId: "removed" })).toThrow("no longer available");
  });

  it("keeps root's system edits in the system layer when a personal layer also exists", () => {
    const models: AiModelsResult = { models: [model("personal"), model("system-one", "system"), model("system-two", "system"), model("base", "base")], preferredModelId: null };
    const next = moveModel(models, configuredModelOrder(models, 0), 0, "system-two", -1);
    expect(orderedModels(models, next, 0).map((entry) => entry.id)).toEqual(["personal", "system-two", "system-one", "base"]);
    expect(modelOrderWrites(models, [storedLayer(models, 0)], 0, next).map((entry) => entry.key)).toEqual(["config/ai/models"]);
    const first = useModelFirst(models, next, 0, "system-two");
    expect(orderedModels(models, first, 0)[0].id).toBe("system-two");
  });

  it("refuses to delete a system profile hidden by root's personal layer when reordering visible models", () => {
    const visible: AiModelsResult = { models: [model("personal"), model("visible-one", "system"), model("visible-two", "system")], preferredModelId: null };
    const complete: AiModelsResult = { ...visible, models: [...visible.models, { ...model("shadowed", "system"), model: "personal-model" }] };
    const config = [storedLayer(complete, 0), { key: "config/ai/models/shadowed/api_key", value: "preserved-fixture", redacted: false }];
    const before = JSON.stringify(config);
    const order = configuredModelOrder(visible, 0);
    expect(() => modelOrderWrites(visible, config, 0, moveModel(visible, order, 0, "visible-two", -1))).toThrow("stored model layer");
    expect(JSON.stringify(config)).toBe(before);
    expect(modelOrderWrites(visible, config, 0, { ...order, preferredId: "visible-two" })).toEqual([{ key: "users/0/ai/preferred_model", value: "visible-two" }]);
  });

  it("refuses an order write when the stored layer disappeared, changed order, or is unreadable", () => {
    const models = listing();
    const draft = moveModel(models, configuredModelOrder(models, 1000), 1000, "two", -1);
    const reordered = { ...models, models: [models.models[1], models.models[0], ...models.models.slice(2)] };
    for (const config of [[], [storedLayer(reordered)], [{ ...storedLayer(models), value: "malformed" }], [{ ...storedLayer(models), redacted: true }]]) {
      expect(() => modelOrderWrites(models, config, 1000, draft)).toThrow("stored model layer");
    }
  });
});
