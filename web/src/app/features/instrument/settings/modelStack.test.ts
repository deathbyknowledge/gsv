import { describe, expect, it } from "vitest";
import type { AiModelListEntry, AiModelsResult } from "@humansandmachines/gsv/protocol";
import type { ConsoleConfigEntry } from "../../../domain/system/consoleModels";
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
  it("drags inherited-only models and stores IDs without copying their definitions", () => {
    const models: AiModelsResult = { models: [model("shared", "system"), model("included", "base")], preferredModelId: null };
    const moved = moveModelTo(models, configuredModelOrder(models), "included", 0);
    expect(orderedModels(models, moved).map((entry) => entry.id)).toEqual(["included", "shared"]);
    expect(modelOrderWrites(models, [], 1000, moved)).toEqual([
      { key: "users/1000/ai/model_order", value: '["included","shared"]' },
    ]);
    expect(models.models.map((entry) => entry.source)).toEqual(["system", "base"]);
  });

  it("moves freely across all layers, including the old first-choice preference", () => {
    const models = listing("included");
    const order = configuredModelOrder(models);
    const moved = moveModel(models, order, "included", 1);
    expect(moved).toEqual({ ids: ["one", "included", "two", "three", "shared"], customized: true });
    expect(modelOrderWrites(models, [{ key: "users/1000/ai/preferred_model", value: "included", redacted: false }], 1000, moved)).toEqual([
      { key: "users/1000/ai/model_order", value: JSON.stringify(moved.ids) },
      { key: "users/1000/ai/preferred_model", value: "" },
    ]);
    expect(moveModel(models, moved, "one", -1)).toBe(moved);
    expect(moveModelTo(models, moved, "missing", 0)).toBe(moved);
    expect(moveModelTo(models, moved, "two", 5)).toBe(moved);
  });

  it("shows saved cross-layer order while skipping removed models and appending new ones", () => {
    const models = { ...listing(), modelOrder: ["removed", "included", "three"] };
    const order = configuredModelOrder(models);
    expect(order.ids).toEqual(["included", "three", "one", "two", "shared"]);
    expect(models.models.map((entry) => entry.id)).toEqual(["one", "two", "three", "shared", "included"]);
    expect(useModelFirst(models, order, "shared").ids).toEqual(["shared", "included", "three", "one", "two"]);
  });

  it("preserves connection settings and never rewrites credential keys during an order edit", () => {
    const models = listing();
    const config = [storedLayer(models), { key: "users/1000/ai/models/two/api_key", value: "private-fixture", redacted: false }];
    const before = JSON.stringify(config);
    const next = useModelFirst(models, configuredModelOrder(models), "two");
    const writes = modelOrderWrites(models, config, 1000, next);
    expect(writes).toHaveLength(1);
    expect(writes[0].key).toBe("users/1000/ai/model_order");
    // SAFETY: the preceding assertions establish the sole model-list write, which always carries its serialized value.
    const stored = JSON.parse(writes[0].value!);
    expect(stored).toEqual(["two", "one", "three", "shared", "included"]);
    expect(JSON.stringify(config)).toBe(before);
    expect(writes[0].value).not.toContain("private-fixture");
    expect(writes[0].value).not.toContain("apiKey");
  });

  it("refuses a stale draft when available models have been added, removed, or duplicated", () => {
    const models = listing();
    for (const ids of [["one", "two"], ["one", "two", "three", "shared", "missing"], ["one", "two", "three", "shared", "shared"]]) {
      expect(() => modelOrderWrites(models, [], 1000, { ids, customized: true })).toThrow("changed while you were editing");
    }
  });

  it("keeps root's order personal and preserves profiles hidden by higher layers", () => {
    const visible: AiModelsResult = { models: [model("personal"), model("visible", "system"), model("base", "base")], preferredModelId: null };
    const complete = { ...visible, models: [...visible.models, model("shadowed", "system")] };
    const config = [storedLayer(complete, 0), { key: "config/ai/models/shadowed/api_key", value: "preserved-fixture", redacted: false }];
    const before = JSON.stringify(config);
    const order = moveModelTo(visible, configuredModelOrder(visible), "base", 0);
    expect(modelOrderWrites(visible, config, 0, order)).toEqual([
      { key: "users/0/ai/model_order", value: '["base","personal","visible"]' },
    ]);
    expect(JSON.stringify(config)).toBe(before);
  });

  it("restores configured order by clearing both the order and any older first-choice preference", () => {
    const models = { ...listing("included"), modelOrder: ["three", "shared"] };
    const config = [
      { key: "users/1000/ai/model_order", value: JSON.stringify(models.modelOrder), redacted: false },
      { key: "users/1000/ai/preferred_model", value: "included", redacted: false },
    ];
    const reset = { ids: models.models.map((model) => model.id), customized: false };
    expect(modelOrderWrites(models, config, 1000, reset)).toEqual([
      { key: "users/1000/ai/model_order", value: "" },
      { key: "users/1000/ai/preferred_model", value: "" },
    ]);
    expect(orderedModels(models, reset)).toEqual(models.models);
  });
});
