/**
 * ConfigStore — SQLite key-value store for runtime configuration.
 *
 * Exposed to userspace via /sys/config/* (system-wide, root-only writes)
 * and /sys/users/{uid}/* (per-user, owner or root writes).
 *
 * Keys are virtual path segments stripped of the /sys/ prefix:
 *   "config/ai/models"       → /sys/config/ai/models
 *   "users/1000/ai/models"   → /sys/users/1000/ai/models
 *
 * SQLite stores explicit overrides. SYSTEM_CONFIG_DEFAULTS is overlaid at
 * read time so code defaults remain live unless a key is explicitly set.
 */

import {
  GSV_CONTEXT_DISCOVERY,
  GSV_PROCESS_ORCHESTRATION,
  GSV_RESPONSIBILITY_CONTEXT,
  GSV_RUNTIME_CONTEXT,
  GSV_RUNTIME_FACTS,
  GSV_TARGET_CONTEXT,
} from "../prompts/system";
import {
  DEFAULT_TEXT_GENERATION_MAX_TOKENS,
  DEFAULT_WORKERS_AI_FALLBACK_MODEL,
  DEFAULT_WORKERS_AI_FALLBACK_PROFILE_ID,
  DEFAULT_WORKERS_AI_FALLBACK_PROFILE_NAME,
  DEFAULT_WORKERS_AI_MODEL,
  GSV_INCLUDED_CONTEXT_WINDOW_TOKENS,
} from "../inference/default-models";
import { MAIL_SEND } from "../syscalls/constants";
import {
  DEFAULT_SHELL_EXEC_TIMEOUT_MS,
  GSV_INFERENCE_MODEL,
  GSV_INFERENCE_PROVIDER,
} from "@humansandmachines/gsv/protocol";
import {
  aiModelApiKeyConfigKey,
  isAiModelStackConfigKey,
  isSameAiModelCredentialScope,
  parseAiModelApiKeyConfigKey,
  parseAiModelStack,
} from "./ai-model-stack";

// =============================================================================
// System config defaults — every field documented.
//
// Keys live under "config/" and are exposed at /sys/config/*.
// Per-user overrides go under "users/{uid}/" at /sys/users/{uid}/*.
// =============================================================================

const WORKER_TOOL_APPROVAL_POLICY = JSON.stringify({
  default: "auto",
  rules: [
    { match: "shell.exec", action: "ask" },
    { match: "net.fetch", action: "ask" },
    { match: "fs.delete", action: "ask" },
    { match: "sys.mcp.call", action: "ask" },
    { match: MAIL_SEND, action: "ask" },
  ],
});

type SystemConfigDefaults = { readonly [key: string]: string };

function defineSystemConfigDefaults<T extends SystemConfigDefaults>(
  defaults: T,
): SystemConfigDefaults & T {
  return defaults;
}

const DEFAULT_AI_MODELS = JSON.stringify({
  version: 1,
  models: [
    {
      id: "workers-ai-glm-5-3-flash",
      name: "GLM 5.3 Flash",
      provider: "workers-ai",
      model: DEFAULT_WORKERS_AI_MODEL,
      maxTokens: DEFAULT_TEXT_GENERATION_MAX_TOKENS,
    },
    {
      id: DEFAULT_WORKERS_AI_FALLBACK_PROFILE_ID,
      name: DEFAULT_WORKERS_AI_FALLBACK_PROFILE_NAME,
      provider: "workers-ai",
      model: DEFAULT_WORKERS_AI_FALLBACK_MODEL,
      maxTokens: DEFAULT_TEXT_GENERATION_MAX_TOKENS,
    },
  ],
});

const MANAGED_DEFAULT_AI_MODELS = JSON.stringify({
  version: 1,
  models: [{
    id: "gsv-included",
    name: "GSV Included",
    provider: GSV_INFERENCE_PROVIDER,
    model: GSV_INFERENCE_MODEL,
    maxTokens: DEFAULT_TEXT_GENERATION_MAX_TOKENS,
    contextWindowTokens: GSV_INCLUDED_CONTEXT_WINDOW_TOKENS,
  }],
});

export const SYSTEM_CONFIG_DEFAULTS = defineSystemConfigDefaults({
  // -- AI / LLM ---------------------------------------------------------------
  // Complete text-model entries in primary/fallback order. Per-owner stacks
  // live at users/{uid}/ai/models and replace this list as a unit.
  "config/ai/models": DEFAULT_AI_MODELS,
  // Reasoning effort/mode hint passed to the model (off, minimal, low, medium, high, xhigh).
  // Only applies to models that support extended thinking.
  "config/ai/reasoning": "medium",
  // System prompt context, assembled in lexical order, applied to every
  // process. Per-agent persona/context lives in each account's home
  // (/home/<account>/context.d), seeded at account creation.
  "config/ai/context.d/00-runtime.md": GSV_RUNTIME_FACTS,
  "config/ai/context.d/01-gsv.md": GSV_RUNTIME_CONTEXT,
  "config/ai/context.d/05-targets.md": GSV_TARGET_CONTEXT,
  "config/ai/context.d/10-responsibilities.md": GSV_RESPONSIBILITY_CONTEXT,
  "config/ai/context.d/20-discovery.md": GSV_CONTEXT_DISCOVERY,
  "config/ai/context.d/30-process-orchestration.md": GSV_PROCESS_ORCHESTRATION,
  // Prompt-visible skill enumeration. Detailed skill discovery remains available
  // through `man --search` and `skills` even when this is `off`.
  "config/ai/skills/index_mode": "summary",
  // Max total bytes for ~/context.d/ files included in the prompt.
  "config/ai/max_context_bytes": "32768",
  // Maximum time to wait for a single model generation before releasing the run.
  "config/ai/generation/timeout_ms": "180000",
  // Generation streaming transport: auto streams when supported, off forces final-output only.
  "config/ai/generation/streaming": "auto",
  // Moondream image-reading resource limits used by process attachments and AI syscalls.
  "config/ai/image/read/max_bytes": "10485760",
  "config/ai/image/read/max_tokens": "28672",
  "config/ai/image/read/max_objects": "150",
  "config/ai/image/read/timeout_ms": "30000",
  "config/ai/image/generation/provider": "workers-ai",
  "config/ai/image/generation/model": "@cf/black-forest-labs/flux-1-schnell",
  "config/ai/image/generation/api_key": "",
  "config/ai/transcription/provider": "workers-ai",
  "config/ai/transcription/model": "@cf/openai/whisper-large-v3-turbo",
  "config/ai/transcription/api_key": "",
  "config/ai/transcription/max_bytes": "26214400",
  "config/ai/speech/provider": "workers-ai",
  "config/ai/speech/model": "@cf/deepgram/aura-2-en",
  "config/ai/speech/api_key": "",
  "config/ai/speech/speaker": "luna",
  "config/ai/speech/encoding": "mp3",
  "config/ai/speech/max_chars": "4000",
  "config/ai/speech/timeout_ms": "30000",

  // -- Server -----------------------------------------------------------------
  // Human-readable name for this GSV instance.
  "config/server/name": "gsv",
  // Timezone used for cron scheduling and log timestamps (IANA format).
  "config/server/timezone": "UTC",
  // The current server version (set at boot, read-only for users).
  "config/server/version": "0.4.1",

  // -- Shell ------------------------------------------------------------------
  // Default shell timeout in ms for native shell.exec.
  "config/shell/timeout_ms": String(DEFAULT_SHELL_EXEC_TIMEOUT_MS),
  // Whether curl/wget are enabled in the native bash shell (true/false).
  "config/shell/network_enabled": "true",
  // Max output size in bytes for shell command results.
  "config/shell/max_output_bytes": "524288",

  // Global default tool approval policy for agent tool execution. JSON object
  // with a default action and ordered rules matching exact syscalls or domain
  // wildcards. Per-account overrides live under `users/<uid>/ai/tools/approval`.
  "config/ai/tools/approval": WORKER_TOOL_APPROVAL_POLICY,
});

// Per-user config keys follow the same structure under "users/{uid}/ai/*".
// e.g. "users/1000/ai/models" replaces "config/ai/models" for uid 1000.
// Only AI config and UI presentation prefs (e.g. "users/{uid}/ui/avatar") are
// user-overridable; server/shell/process config is system-only.
export const USER_OVERRIDABLE_PREFIXES = ["ai/", "ui/"] as const;

type ConfigStoreOptions = {
  managedInferenceAvailable?: boolean;
};

export class ConfigStore {
  private readonly defaults: SystemConfigDefaults;

  constructor(
    private readonly sql: SqlStorage,
    options: ConfigStoreOptions = {},
  ) {
    this.defaults = options.managedInferenceAvailable
      ? {
        ...SYSTEM_CONFIG_DEFAULTS,
        "config/ai/models": MANAGED_DEFAULT_AI_MODELS,
      }
      : SYSTEM_CONFIG_DEFAULTS;
  }

  get(key: string): string | null {
    return this.getExplicit(key) ?? this.defaults[key] ?? null;
  }

  getExplicit(key: string): string | null {
    const rows = this.sql.exec<{ value: string }>(
      "SELECT value FROM config_kv WHERE key = ?",
      key,
    ).toArray();
    return rows.length > 0 ? rows[0].value : null;
  }

  set(key: string, value: string): void {
    const credential = parseAiModelApiKeyConfigKey(key);
    if (credential) {
      const stack = parseAiModelStack(this.get(credential.stackKey));
      if (!stack?.models.some((model) => model.id === credential.modelId)) {
        throw new Error(
          `AI model ${credential.modelId} is not configured at /sys/${credential.stackKey}`,
        );
      }
    }
    if (isAiModelStackConfigKey(key)) {
      if (key.startsWith("users/") && value.trim().length === 0) {
        this.delete(key);
        return;
      }
      const nextStack = parseAiModelStack(value);
      if (!nextStack) {
        throw new Error(`Invalid AI model stack at /sys/${key}`);
      }
      this.clearDetachedAiModelCredentials(key, nextStack);
    }
    this.sql.exec(
      "INSERT OR REPLACE INTO config_kv (key, value) VALUES (?, ?)",
      key,
      value,
    );
  }

  delete(key: string): boolean {
    const existing = this.getExplicit(key);
    if (isAiModelStackConfigKey(key) && (existing !== null || key.startsWith("users/"))) {
      this.clearDetachedAiModelCredentials(key, null);
    }
    if (existing === null) return false;
    this.sql.exec("DELETE FROM config_kv WHERE key = ?", key);
    return true;
  }

  /**
   * List all keys (and values) under a prefix.
   * e.g. list("config/ai") returns all /sys/config/ai/* entries.
   */
  list(prefix: string): { key: string; value: string }[] {
    const merged = new Map<string, string>();
    for (const [key, value] of Object.entries(this.defaults)) {
      if (matchesConfigPrefix(key, prefix)) {
        merged.set(key, value);
      }
    }
    for (const { key, value } of this.listExplicit(prefix)) {
      merged.set(key, value);
    }

    return [...merged.entries()]
      .map(([key, value]) => ({ key, value }))
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  listExplicit(prefix: string): { key: string; value: string }[] {
    const normalized = prefix.trim();
    if (normalized.length === 0) {
      return this.sql.exec<{ key: string; value: string }>(
        "SELECT key, value FROM config_kv ORDER BY key",
      ).toArray();
    }

    const pattern = normalized.endsWith("/") ? normalized : normalized + "/";
    return this.sql.exec<{ key: string; value: string }>(
      "SELECT key, value FROM config_kv WHERE key LIKE ? ORDER BY key",
      pattern + "%",
    ).toArray();
  }

  private clearDetachedAiModelCredentials(
    stackKey: string,
    nextStack: ReturnType<typeof parseAiModelStack>,
  ): void {
    const currentStack = parseAiModelStack(this.get(stackKey));
    const currentById = new Map((currentStack?.models ?? []).map((model) => [model.id, model]));
    const nextById = new Map((nextStack?.models ?? []).map((model) => [model.id, model]));
    for (const entry of this.listExplicit(stackKey)) {
      const relative = entry.key.slice(`${stackKey}/`.length);
      const match = /^([^/]+)\/api_key$/.exec(relative);
      if (!match) {
        continue;
      }
      const modelId = match[1];
      const current = currentById.get(modelId);
      const next = nextById.get(modelId);
      if (!current || !next || !isSameAiModelCredentialScope(current, next)) {
        this.sql.exec(
          "DELETE FROM config_kv WHERE key = ?",
          aiModelApiKeyConfigKey(stackKey, modelId),
        );
      }
    }
  }
}

function matchesConfigPrefix(key: string, prefix: string): boolean {
  const normalized = prefix.trim();
  if (normalized.length === 0) {
    return true;
  }
  const pattern = normalized.endsWith("/") ? normalized : normalized + "/";
  return key.startsWith(pattern);
}
