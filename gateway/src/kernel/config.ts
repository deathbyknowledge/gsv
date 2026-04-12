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
 * System config is the runtime truth. R2 dotfiles (/etc/gsv/config,
 * ~/.config/gsv/config) are seed files loaded on first connect.
 */

// =============================================================================
// System config defaults — every field documented.
//
// Keys live under "config/" and are exposed at /sys/config/*.
// Per-user overrides go under "users/{uid}/" at /sys/users/{uid}/*.
// =============================================================================

export const SYSTEM_CONFIG_DEFAULTS: Record<string, string> = {
  // -- AI / LLM ---------------------------------------------------------------
  // The LLM provider to use (workers-ai, anthropic, openai, google, mistral, etc.)
  "config/ai/provider": "workers-ai",
  // The model identifier for the LLM provider
  "config/ai/model": "@cf/nvidia/nemotron-3-120b-a12b",
  // API key for the LLM provider. Empty is valid for local providers such as Workers AI.
  "config/ai/api_key": "",
  // Reasoning effort/mode hint passed to the model (off, low, medium, high).
  // Only applies to models that support extended thinking.
  "config/ai/reasoning": "off",
  // Max tokens for LLM responses (model-dependent upper bound).
  "config/ai/max_tokens": "8192",
  // Default system prompt. Injected as the first layer of the assembled prompt.
  "config/ai/system_prompt":
    "You are an AI agent running inside GSV, a distributed operating system. You have access to tools for reading/writing files, executing shell commands, and managing processes. Use them to help the user accomplish their goals.",
  // Profile-specific prompt supplements. These are mutable runtime state and
  // let operator-style processes like mcp change how a profile behaves without
  // editing code.
  "config/ai/profile/init/system_prompt":
    "You are the user's persistent init process. Coordinate long-lived context and spawn focused child processes when needed.",
  "config/ai/profile/task/system_prompt":
    "You are the active task process for a user thread. Work directly in the current workspace and leave durable artifacts there.",
  "config/ai/profile/review/system_prompt":
    "You are a package review process. Inspect mounted package code, declared capabilities, commit history, and source identity. Be skeptical, evidence-driven, and concise. Start from package metadata and source inspection, keep tool use tight, do not narrate trivial navigation, and do not guess when a command fails. Call out privileged integrations explicitly, including host bridge access, parent-window messaging, process spawning, network access, filesystem writes, shell execution, eval, and destructive actions. End with a clear verdict: approve or do not approve.",
  "config/ai/profile/cron/system_prompt":
    "You are a scheduled background process. Act predictably, avoid interactive assumptions, and leave concise durable summaries.",
  "config/ai/profile/mcp/system_prompt":
    "You are the master control process. Focus on live diagnosis, deployment state, kernel state, and precise operational changes.",
  "config/ai/profile/app/system_prompt":
    "You are an app-owned runtime process. Follow the app's configuration and produce durable artifacts for the user.",
  // Max total bytes for ~/context.d/ files included in the prompt.
  "config/ai/max_context_bytes": "32768",

  // -- Server -----------------------------------------------------------------
  // Human-readable name for this GSV instance.
  "config/server/name": "gsv",
  // Timezone used for cron scheduling and log timestamps (IANA format).
  "config/server/timezone": "UTC",
  // The current server version (set at boot, read-only for users).
  "config/server/version": "0.0.1",

  // -- Shell ------------------------------------------------------------------
  // Default shell timeout in ms for native shell.exec.
  "config/shell/timeout_ms": "30000",
  // Whether curl/wget are enabled in the native bash shell (true/false).
  "config/shell/network_enabled": "true",
  // Max output size in bytes for shell command results.
  "config/shell/max_output_bytes": "524288",

  // -- Processes ---------------------------------------------------------------
  // Default label format for init processes. {username} is replaced.
  "config/process/init_label": "init ({username})",
  // Max concurrent processes per user (0 = unlimited).
  "config/process/max_per_user": "0",
  // Tool approval policy for agent tool execution. JSON object with a default
  // action and ordered rules matching exact syscalls or domain wildcards.
  "config/tools/approval": "{\"default\":\"auto\",\"rules\":[{\"match\":\"shell.exec\",\"action\":\"ask\"},{\"match\":\"fs.delete\",\"action\":\"ask\"}]}",
};

// Per-user config keys follow the same structure under "users/{uid}/ai/*".
// e.g. "users/1000/ai/provider" overrides "config/ai/provider" for uid 1000.
// Only AI config is user-overridable; server/shell/process config is system-only.
export const USER_OVERRIDABLE_PREFIXES = ["ai/"] as const;

export class ConfigStore {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS config_kv (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }

  get(key: string): string | null {
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
    const existing = this.get(key);
    if (existing === null) return false;
    this.sql.exec("DELETE FROM config_kv WHERE key = ?", key);
    return true;
  }

  /**
   * List all keys (and values) under a prefix.
   * e.g. list("config/ai") returns all /sys/config/ai/* entries.
   */
  list(prefix: string): { key: string; value: string }[] {
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

  /**
   * Seed defaults — only inserts keys that don't already exist.
   */
  seed(defaults: Record<string, string>): void {
    for (const [key, value] of Object.entries(defaults)) {
      this.sql.exec(
        "INSERT OR IGNORE INTO config_kv (key, value) VALUES (?, ?)",
        key,
        value,
      );
    }
  }
}
