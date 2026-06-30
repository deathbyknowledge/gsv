/**
 * ConfigStore — SQLite key-value store for runtime configuration.
 *
 * Exposed to userspace via /sys/config/* (system-wide, root-only writes)
 * and /sys/users/{uid}/* (per-user, owner or root writes).
 *
 * Keys are virtual path segments stripped of the /sys/ prefix:
 *   "config/ai/provider"   → /sys/config/ai/provider
 *   "users/0/ai/model"     → /sys/users/0/ai/model
 *
 * SQLite stores explicit overrides. SYSTEM_CONFIG_DEFAULTS is overlaid at
 * read time so code defaults remain live unless a key is explicitly set.
 */

import {
  GSV_CONTEXT_DISCOVERY,
  GSV_PROCESS_ORCHESTRATION,
  GSV_RUNTIME_CONTEXT,
  GSV_RUNTIME_FACTS,
  GSV_TARGET_CONTEXT,
} from "../prompts/system";

// =============================================================================
// System config defaults — every field documented.
//
// Keys live under "config/" and are exposed at /sys/config/*.
// Per-user overrides go under "users/{uid}/" at /sys/users/{uid}/*.
// =============================================================================

const WORKER_TOOL_APPROVAL_POLICY = JSON.stringify({
  default: "auto",
  rules: [
    { match: "shell.exec", when: { anyTag: ["destructive", "privileged", "network", "mutating", "unclassified"] }, action: "ask" },
    { match: "net.fetch", when: { anyTag: ["network", "mutating"] }, action: "ask" },
    { match: "fs.delete", action: "ask" },
    { match: "sys.mcp.call", action: "ask" },
  ],
});

export const SYSTEM_CONFIG_DEFAULTS: Record<string, string> = {
  // -- AI / LLM ---------------------------------------------------------------
  // The LLM provider to use (workers-ai, anthropic, openai, google, mistral, etc.)
  "config/ai/provider": "workers-ai",
  // The model identifier for the LLM provider
  "config/ai/model": "@cf/nvidia/nemotron-3-120b-a12b",
  // API key for the LLM provider. Empty is valid for local providers such as Workers AI.
  "config/ai/api_key": "",
  // Reasoning effort/mode hint passed to the model (off, minimal, low, medium, high, xhigh).
  // Only applies to models that support extended thinking.
  "config/ai/reasoning": "medium",
  // Max tokens for LLM responses (model-dependent upper bound).
  "config/ai/max_tokens": "8192",
  // Fallback context window for providers that are not in the local model registry.
  "config/ai/context_window_tokens": "256000",
  // System prompt context, assembled in lexical order, applied to every
  // process. Per-agent persona/context lives in each account's home
  // (/home/<account>/context.d), seeded at account creation.
  "config/ai/context.d/00-gsv.md": GSV_RUNTIME_CONTEXT,
  "config/ai/context.d/05-targets.md": GSV_TARGET_CONTEXT,
  "config/ai/context.d/10-runtime.md": GSV_RUNTIME_FACTS,
  "config/ai/context.d/20-discovery.md": GSV_CONTEXT_DISCOVERY,
  "config/ai/context.d/30-process-orchestration.md": GSV_PROCESS_ORCHESTRATION,
  // Max total bytes for ~/context.d/ files included in the prompt.
  "config/ai/max_context_bytes": "32768",
  // Maximum time to wait for a single model generation before releasing the run.
  "config/ai/generation/timeout_ms": "180000",
  // Generation streaming transport: auto streams when supported, off forces final-output only.
  "config/ai/generation/streaming": "auto",
  // Default media model stack used by process attachments and AI syscalls.
  "config/ai/image/read/provider": "workers-ai",
  "config/ai/image/read/model": "@cf/google/gemma-4-26b-a4b-it",
  "config/ai/image/read/api_key": "",
  "config/ai/image/read/input_format": "auto",
  "config/ai/image/read/max_bytes": "10485760",
  "config/ai/image/read/max_tokens": "512",
  "config/ai/image/read/timeout_ms": "30000",
  "config/ai/image/read/prompt": "Describe this image for an AI assistant that cannot see it. Include visible text, UI details, objects, people, layout, and any information needed to answer follow-up questions.",
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
  "config/server/version": "0.3.0",

  // -- Shell ------------------------------------------------------------------
  // Default shell timeout in ms for native shell.exec.
  "config/shell/timeout_ms": "30000",
  // Whether curl/wget are enabled in the native bash shell (true/false).
  "config/shell/network_enabled": "true",
  // Max output size in bytes for shell command results.
  "config/shell/max_output_bytes": "524288",

  // Global default tool approval policy for agent tool execution. JSON object
  // with a default action and ordered rules matching exact syscalls or domain
  // wildcards. Per-account overrides live under `users/<uid>/ai/tools/approval`.
  "config/ai/tools/approval": WORKER_TOOL_APPROVAL_POLICY,
};

// Per-user config keys follow the same structure under "users/{uid}/ai/*".
// e.g. "users/1000/ai/provider" overrides "config/ai/provider" for uid 1000.
// Only AI config is user-overridable; server/shell/process config is system-only.
export const USER_OVERRIDABLE_PREFIXES = ["ai/"] as const;

export class ConfigStore {
  constructor(private readonly sql: SqlStorage) {}

  get(key: string): string | null {
    return this.getExplicit(key) ?? SYSTEM_CONFIG_DEFAULTS[key] ?? null;
  }

  getExplicit(key: string): string | null {
    const rows = this.sql.exec<{ value: string }>(
      "SELECT value FROM config_kv WHERE key = ?",
      key,
    ).toArray();
    return rows.length > 0 ? rows[0].value : null;
  }

  set(key: string, value: string): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO config_kv (key, value) VALUES (?, ?)",
      key,
      value,
    );
  }

  delete(key: string): boolean {
    const existing = this.getExplicit(key);
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
    for (const [key, value] of Object.entries(SYSTEM_CONFIG_DEFAULTS)) {
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
}

function matchesConfigPrefix(key: string, prefix: string): boolean {
  const normalized = prefix.trim();
  if (normalized.length === 0) {
    return true;
  }
  const pattern = normalized.endsWith("/") ? normalized : normalized + "/";
  return key.startsWith(pattern);
}
