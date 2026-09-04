import { describe, expect, it } from "vitest";
import { ConfigStore, SYSTEM_CONFIG_DEFAULTS } from "./config";
import {
  DEFAULT_TEXT_GENERATION_MAX_TOKENS,
  DEFAULT_WORKERS_AI_FALLBACK_MODEL,
  DEFAULT_WORKERS_AI_FALLBACK_PROFILE_ID,
  DEFAULT_WORKERS_AI_MODEL,
} from "../inference/default-models";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { parseAiModelStack } from "./ai-model-stack";

describe("ConfigStore", () => {
  it("defaults text and image generation to their supported output budgets", () => {
    const stack = parseAiModelStack(SYSTEM_CONFIG_DEFAULTS["config/ai/models"]);
    expect(stack?.models.every((model) =>
      model.maxTokens === DEFAULT_TEXT_GENERATION_MAX_TOKENS
    )).toBe(true);
    expect(SYSTEM_CONFIG_DEFAULTS["config/ai/image/read/max_tokens"])
      .toBe("28672");
  });

  it("defaults native shell execution to two minutes", () => {
    expect(SYSTEM_CONFIG_DEFAULTS["config/shell/timeout_ms"]).toBe("120000");
  });

  const configuredStoreTest = it.extend<{ store: ConfigStore }>({
    store: async ({ task: _task }, use) => {
      await runWithRealKernelSql(async (sql) => {
        const store = new ConfigStore(sql);
        store.set("config/ai/generation/streaming", "off");
        store.set("users/0/ai/preferred_model", "fast");
        await use(store);
      });
    },
  });

  configuredStoreTest(
    "get overlays defaults unless an explicit value is set",
    ({ store }) => {
      expect(store.get("config/ai/models")).toBeTruthy();
      expect(store.getExplicit("config/ai/models")).toBeNull();
      expect(store.get("config/ai/generation/streaming")).toBe("off");
      expect(store.getExplicit("config/ai/generation/streaming")).toBe("off");
    },
  );

  configuredStoreTest(
    "delete removes explicit values and reveals defaults",
    ({ store }) => {
      expect(store.delete("config/ai/generation/streaming")).toBe(true);
      expect(store.getExplicit("config/ai/generation/streaming")).toBeNull();
      expect(store.get("config/ai/generation/streaming")).toBe("auto");
      expect(store.delete("config/ai/generation/streaming")).toBe(false);
    },
  );

  configuredStoreTest(
    'listExplicit("") returns only stored override keys',
    ({ store }) => {
      const all = store.list("");
      expect(store.listExplicit("").map((entry) => entry.key)).toEqual([
        "config/ai/generation/streaming",
        "users/0/ai/preferred_model",
      ]);
      expect(all.length).toBeGreaterThan(3);
      expect(new Set(all.map((entry) => entry.key)).size).toBe(all.length);
    },
  );

  configuredStoreTest(
    "list(prefix) merges defaults and explicit overrides",
    ({ store }) => {
      const ai = store.list("config/ai");
      const values = new Map(ai.map((entry) => [entry.key, entry.value]));
      expect(values.get("config/ai/models")).toBeTruthy();
      expect(values.get("config/ai/generation/streaming")).toBe("off");
      expect(values.get("config/ai/context.d/01-gsv.md")).toContain(
        "[GSV EVENT]",
      );
    },
  );

  it("keeps model credentials attached to one unchanged connection", () =>
    runWithRealKernelSql((sql) => {
      const store = new ConfigStore(sql);
      const stackKey = "users/1000/ai/models";
      const primary = { id: "primary", name: "Primary", provider: "openai", model: "gpt-5" };
      const backup = { id: "backup", name: "Backup", provider: "anthropic", model: "claude" };
      store.set(stackKey, JSON.stringify({ version: 1, models: [primary, backup] }));
      store.set(`${stackKey}/primary/api_key`, "sk-primary");
      store.set(`${stackKey}/backup/api_key`, "sk-backup");

      store.set(stackKey, JSON.stringify({
        version: 1,
        models: [{ ...backup, name: "Fallback", maxTokens: 16_384 }, primary],
      }));
      expect(store.get(`${stackKey}/primary/api_key`)).toBe("sk-primary");
      expect(store.get(`${stackKey}/backup/api_key`)).toBe("sk-backup");

      store.set(stackKey, JSON.stringify({
        version: 1,
        models: [{ ...backup, provider: "custom", baseUrl: "https://new.example/v1" }, primary],
      }));
      expect(store.get(`${stackKey}/primary/api_key`)).toBe("sk-primary");
      expect(store.get(`${stackKey}/backup/api_key`)).toBeNull();

      store.set(stackKey, "");
      expect(store.getExplicit(stackKey)).toBeNull();
      expect(store.get(`${stackKey}/primary/api_key`)).toBeNull();
    }));

  it("rejects an invalid model stack without detaching its credential", () =>
    runWithRealKernelSql((sql) => {
      const store = new ConfigStore(sql);
      const stackKey = "users/1000/ai/models";
      const stack = JSON.stringify({
        version: 1,
        models: [{ id: "primary", name: "Primary", provider: "openai", model: "gpt-5" }],
      });
      store.set(stackKey, stack);
      store.set(`${stackKey}/primary/api_key`, "sk-primary");

      expect(() => store.set(
        stackKey,
        JSON.stringify({ version: 1, models: [] }),
      )).toThrow(`Invalid AI model stack at /sys/${stackKey}`);
      expect(store.get(stackKey)).toBe(stack);
      expect(store.get(`${stackKey}/primary/api_key`)).toBe("sk-primary");
    }));

  it("rejects a credential without its model entry", () =>
    runWithRealKernelSql((sql) => {
      const store = new ConfigStore(sql);

      expect(() => store.set(
        "users/1000/ai/models/missing/api_key",
        "sk-detached",
      )).toThrow(
        "AI model missing is not configured at /sys/users/1000/ai/models",
      );
      expect(store.get("users/1000/ai/models/missing/api_key")).toBeNull();
    }));

  it("ships an ordered Workers AI primary and fallback stack", () =>
    runWithRealKernelSql((sql) => {
      const store = new ConfigStore(sql);
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      const stack = JSON.parse(
        store.get("config/ai/models") ?? "{}",
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      ) as {
        models?: Array<{ id?: string; provider?: string; model?: string }>;
      };

      expect(stack.models).toEqual([
        expect.objectContaining({
          provider: "workers-ai",
          model: DEFAULT_WORKERS_AI_MODEL,
        }),
        expect.objectContaining({
          id: DEFAULT_WORKERS_AI_FALLBACK_PROFILE_ID,
          provider: "workers-ai",
          model: DEFAULT_WORKERS_AI_FALLBACK_MODEL,
        }),
      ]);
    }));

  configuredStoreTest(
    "list(prefix with trailing slash) behaves the same",
    ({ store }) => {
      expect(store.list("config/ai/")).toEqual(store.list("config/ai"));
    },
  );

  it("defines lean common process context once for all profiles", () => {
    const context = SYSTEM_CONFIG_DEFAULTS["config/ai/context.d/01-gsv.md"];
    expect(context).toContain("GSV is a personal intelligence OS");
    expect(context).toContain("its own lightweight Linux virtual computer");
    expect(context).toContain("skills show browser-target");
    expect(context).toContain("[GSV EVENT]");
    expect(context).toContain("typed runtime events from GSV");
    const targets = SYSTEM_CONFIG_DEFAULTS["config/ai/context.d/05-targets.md"];
    expect(targets).toContain("message destinations");
    expect(targets).toContain("message attach PATH...");
    expect(targets).toContain("sending does not finish the run");
    expect(targets).toContain("message send");
    expect(targets).toContain("yield");
    expect(targets).toContain(
      "cp source-target:/path destination-target:/path",
    );
    expect(targets).toContain("targets list");
    expect(targets).toContain("must be run from the `gsv` target");
    const responsibilities =
      SYSTEM_CONFIG_DEFAULTS["config/ai/context.d/10-responsibilities.md"];
    expect(responsibilities).toContain("Kernel responsibility ledger");
    expect(responsibilities).toContain("`r12y` command");
    expect(responsibilities).toContain("{{r12y}}");
    const discovery =
      SYSTEM_CONFIG_DEFAULTS["config/ai/context.d/20-discovery.md"];
    expect(discovery).toContain("man --search -- '<plain-language goal>'");
    expect(discovery).toContain("the `mcp` command");
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    expect(discovery).toContain("CodeMode as `mcpTools`");
    expect(discovery).toContain("Load the relevant skill");
    expect(SYSTEM_CONFIG_DEFAULTS["config/ai/skills/index_mode"]).toBe(
      "summary",
    );
    const orchestration =
      SYSTEM_CONFIG_DEFAULTS["config/ai/context.d/30-process-orchestration.md"];
    expect(orchestration).toContain("target `gsv`");
    expect(orchestration).toContain("proc delegate");
    expect(orchestration).toContain("proc spawn");
    expect(orchestration).toContain("sched");
    expect(orchestration).toContain("crontab");
    expect(orchestration).toContain("skills show process-orchestration");
    expect(orchestration).not.toContain("proc agents");
    expect(orchestration).not.toContain("sched add --here");
    const runtimeFacts =
      SYSTEM_CONFIG_DEFAULTS["config/ai/context.d/00-runtime.md"];
    expect(runtimeFacts).toContain(
      "as agent `{{program.username}}` for owner `{{user.username}}`",
    );
    expect(runtimeFacts).toContain("Agent home: {{program.home}}");
    expect(runtimeFacts).toContain("Owner home: {{user.home}}");
    expect(runtimeFacts).toContain(
      "Current working directory: {{program.cwd}}",
    );
    expect(runtimeFacts).toContain("Date: {{current.date}}");
    expect(runtimeFacts).toContain("Timezone: {{current.timezone}}");
  });

  it("defines a global default tool approval policy with explicit guarded tool kinds", () => {
    const policy = JSON.parse(
      SYSTEM_CONFIG_DEFAULTS["config/ai/tools/approval"],
    );

    expect(policy.default).toBe("auto");
    expect(policy.rules).toContainEqual({ match: "shell.exec", action: "ask" });
    expect(policy.rules).toContainEqual({ match: "net.fetch", action: "ask" });
    expect(policy.rules).toContainEqual({ match: "fs.delete", action: "ask" });
    expect(policy.rules).toContainEqual({ match: "mail.send", action: "ask" });
    expect(policy.rules).not.toContainEqual({ match: "mail.status", action: "ask" });
  });
});
