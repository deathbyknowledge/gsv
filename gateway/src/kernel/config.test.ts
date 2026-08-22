import { describe, expect, it } from "vitest";
import { ConfigStore, SYSTEM_CONFIG_DEFAULTS } from "./config";
import {
  DEFAULT_WORKERS_AI_FALLBACK_MODEL,
  DEFAULT_WORKERS_AI_FALLBACK_PROFILE_ID,
  DEFAULT_WORKERS_AI_MODEL,
} from "../inference/default-models";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { MAIL_STATUS } from "../syscalls/constants";

describe("ConfigStore", () => {
  const configuredStoreTest = it.extend<{ store: ConfigStore }>({
    store: async ({}, use) => {
      await runWithRealKernelSql(async (sql) => {
        const store = new ConfigStore(sql);
        store.set("config/ai/provider", "anthropic");
        store.set("config/ai/model", "claude-sonnet-4-6");
        store.set("users/0/ai/model", "gpt-4.1");
        await use(store);
      });
    },
  });

  configuredStoreTest(
    "get overlays defaults unless an explicit value is set",
    ({ store }) => {
      expect(store.get("config/ai/api_key")).toBe("");
      expect(store.getExplicit("config/ai/api_key")).toBeNull();
      expect(store.get("config/ai/provider")).toBe("anthropic");
      expect(store.getExplicit("config/ai/provider")).toBe("anthropic");
    },
  );

  configuredStoreTest(
    "delete removes explicit values and reveals defaults",
    ({ store }) => {
      expect(store.delete("config/ai/provider")).toBe(true);
      expect(store.getExplicit("config/ai/provider")).toBeNull();
      expect(store.get("config/ai/provider")).toBe("workers-ai");
      expect(store.delete("config/ai/provider")).toBe(false);
    },
  );

  configuredStoreTest(
    'listExplicit("") returns only stored override keys',
    ({ store }) => {
      const all = store.list("");
      expect(store.listExplicit("").map((entry) => entry.key)).toEqual([
        "config/ai/model",
        "config/ai/provider",
        "users/0/ai/model",
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
      expect(values.get("config/ai/api_key")).toBe("");
      expect(values.get("config/ai/provider")).toBe("anthropic");
      expect(values.get("config/ai/model")).toBe("claude-sonnet-4-6");
      expect(values.get("config/ai/generation/streaming")).toBe("auto");
      expect(values.get("config/ai/context.d/01-gsv.md")).toContain(
        "[GSV EVENT]",
      );
    },
  );

  it("ships a Workers AI primary model and root fallback profile", () =>
    runWithRealKernelSql((sql) => {
      const store = new ConfigStore(sql);
      const rootProfiles = JSON.parse(
        store.get("users/0/ai/model_profiles") ?? "{}",
      ) as {
        profiles?: Array<{ id?: string; values?: Record<string, string> }>;
      };
      const fallbackProfile = rootProfiles.profiles?.find(
        (profile) => profile.id === DEFAULT_WORKERS_AI_FALLBACK_PROFILE_ID,
      );

      expect(store.get("config/ai/provider")).toBe("workers-ai");
      expect(store.get("config/ai/model")).toBe(DEFAULT_WORKERS_AI_MODEL);
      expect(store.get("config/ai/fallback_model_profile")).toBe(
        DEFAULT_WORKERS_AI_FALLBACK_PROFILE_ID,
      );
      expect(fallbackProfile?.values).toMatchObject({
        "config/ai/provider": "workers-ai",
        "config/ai/model": DEFAULT_WORKERS_AI_FALLBACK_MODEL,
      });
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
    expect(targets).toContain("exactly one Message action");
    expect(targets).toContain("or Silence");
    expect(targets).toContain(
      "cp source-target:/path destination-target:/path",
    );
    expect(targets).toContain("targets list");
    expect(targets).toContain("must be run from the `gsv` target");
    const discovery =
      SYSTEM_CONFIG_DEFAULTS["config/ai/context.d/20-discovery.md"];
    expect(discovery).toContain("man --search -- '<plain-language goal>'");
    expect(discovery).toContain("the `mcp` command");
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
    expect(policy.rules).not.toContainEqual({ match: MAIL_STATUS, action: "ask" });
  });
});
