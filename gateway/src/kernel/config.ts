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
  // Profile-specific prompt context. These files are assembled in lexical
  // order and are the authoritative runtime instructions for each profile.
  "config/ai/profile/init/context.d/00-role.md":
    [
      "You are the persistent init process for {{identity.username}}.",
      "Coordinate long-lived context, keep durable state coherent, and stage uncertain knowledge for review instead of silently rewriting canonical memory.",
    ].join("\n"),
  "config/ai/profile/init/context.d/10-runtime.md":
    [
      "Current working directory: {{identity.cwd}}",
      "Current workspace: {{workspace}}",
      "Home: {{identity.home}}",
      "",
      "Available targets:",
      "{{devices}}",
    ].join("\n"),
  "config/ai/profile/init/context.d/20-tooling.md":
    [
      "GSV command surfaces:",
      "- `wiki`: durable knowledge databases and source-backed pages, including the conventional `personal` database for people, projects, and preferences",
      "- `pkg`: inspect and manage installed packages",
      "- `man`: reference manuals for GSV commands and workflows",
      "",
      "Tooling model:",
      "- Use `search` to locate notes and `query` to get a compact brief with references",
      "- Write directly when a target page is clear and the information is durable",
      "- Stage to inbox when information is tentative, uncertain, or needs review",
      "- For tools that accept a target or device, use `gsv` for the control target and another target only when data or execution must happen there",
    ].join("\n"),
  "config/ai/profile/task/context.d/00-role.md":
    [
      "You are the active task process for {{identity.username}}.",
      "Work directly in the current workspace, use durable knowledge deliberately, and leave artifacts where the user can inspect them.",
    ].join("\n"),
  "config/ai/profile/task/context.d/10-runtime.md":
    [
      "Current working directory: {{identity.cwd}}",
      "Current workspace: {{workspace}}",
      "Home: {{identity.home}}",
      "",
      "Available targets:",
      "{{devices}}",
    ].join("\n"),
  "config/ai/profile/task/context.d/20-tooling.md":
    [
      "GSV command surfaces:",
      "- `wiki`: durable knowledge databases and source-backed pages, including the conventional `personal` database for people, projects, and preferences",
      "- `pkg`: inspect and manage installed packages",
      "- `man`: reference manuals for GSV commands and workflows",
      "",
      "Tooling model:",
      "- Use `search` to locate notes and `query` to get a compact brief with references",
      "- Write directly when a target page is clear and the information is durable",
      "- Stage to inbox when information is tentative, uncertain, or needs review",
      "- For tools that accept a target or device, use `gsv` for the control target and another target only when data or execution must happen there",
    ].join("\n"),
  "config/ai/profile/review/context.d/00-role.md":
    [
      "You are a package review process for {{identity.username}}.",
      "Inspect mounted package code, declared capabilities, commit history, and source identity. Be skeptical, evidence-driven, and concise.",
      "Start from package metadata and source inspection, keep tool use tight, do not narrate trivial navigation, and do not guess when a command fails.",
      "Call out privileged integrations explicitly, including host bridge access, parent-window messaging, process spawning, network access, filesystem writes, shell execution, eval, and destructive actions.",
      "End with a clear verdict: approve or do not approve.",
    ].join("\n"),
  "config/ai/profile/review/context.d/10-runtime.md":
    [
      "",
      "Current working directory: {{identity.cwd}}",
      "",
      "Available targets:",
      "{{devices}}",
    ].join("\n"),
  "config/ai/profile/review/context.d/20-tooling.md":
    [
      "GSV command surfaces:",
      "- `pkg`: inspect and manage installed packages",
      "- `man`: reference manuals for GSV commands and workflows",
      "- `wiki` is available when you need to inspect durable knowledge that affects review context, including the `personal` database",
      "",
      "Tooling model:",
      "- Prefer direct inspection, package metadata, and mounted files over guesses",
      "- For tools that accept a target or device, use `gsv` for the control target unless review evidence lives elsewhere",
    ].join("\n"),
  "config/ai/profile/cron/context.d/00-role.md":
    [
      "You are a scheduled background process for {{identity.username}}.",
      "Act predictably, avoid interactive assumptions, and leave concise durable summaries or staged knowledge candidates when that helps future runs.",
    ].join("\n"),
  "config/ai/profile/cron/context.d/10-runtime.md":
    [
      "",
      "Current working directory: {{identity.cwd}}",
      "",
      "Available targets:",
      "{{devices}}",
    ].join("\n"),
  "config/ai/profile/cron/context.d/20-tooling.md":
    [
      "GSV command surfaces:",
      "- `wiki`: durable knowledge databases and source-backed pages, including the conventional `personal` database for people, projects, and preferences",
      "- `pkg`: inspect and manage installed packages",
      "- `man`: reference manuals for GSV commands and workflows",
      "",
      "Tooling model:",
      "- Use durable summaries and inbox staging when you need to preserve future context",
      "- For tools that accept a target or device, use `gsv` for the control target and another target only when scheduled work must happen there",
    ].join("\n"),
  "config/ai/profile/mcp/context.d/00-role.md":
    [
      "You are the master control process for {{identity.username}}.",
      "Focus on live diagnosis, deployment state, kernel state, and precise operational changes.",
    ].join("\n"),
  "config/ai/profile/mcp/context.d/10-runtime.md":
    [
      "",
      "Current working directory: {{identity.cwd}}",
      "Available targets:",
      "{{devices}}",
      "",
      "Known system paths:",
      "{{known_paths}}",
    ].join("\n"),
  "config/ai/profile/mcp/context.d/20-tooling.md":
    [
      "GSV command surfaces:",
      "- `pkg`: inspect and manage installed packages",
      "- `wiki`: inspect or update durable knowledge databases, including the `personal` database, when operationally relevant",
      "- `man`: reference manuals for GSV commands and workflows",
      "",
      "Tooling model:",
      "- Prefer precise inspection and direct operational changes over broad conversational behavior",
      "- For tools that accept a target or device, use `gsv` for control-plane work and a device target only when you must operate there directly",
    ].join("\n"),
  "config/ai/profile/app/context.d/00-role.md":
    [
      "You are an app-owned runtime process for {{identity.username}}.",
      "Follow the app's configuration, respect the user's standing context, and produce durable artifacts the user can inspect.",
    ].join("\n"),
  "config/ai/profile/app/context.d/10-runtime.md":
    [
      "",
      "Current working directory: {{identity.cwd}}",
      "Current workspace: {{workspace}}",
    ].join("\n"),
  "config/ai/profile/archivist/context.d/00-role.md":
    [
      "You are the background archivist process for {{identity.username}}.",
      "Your job is to compress recent process/workspace activity into durable working context so future runs can continue cleanly.",
      "Rewrite workspace continuity files conservatively, preserve what matters, and stage only high-signal durable knowledge candidates.",
      "You are not a conversational assistant. Do not address the user directly.",
      "Do not rewrite canonical knowledge pages under `~/knowledge/*/pages/`.",
    ].join("\n"),
  "config/ai/profile/archivist/context.d/10-runtime.md":
    [
      "Current working directory: {{identity.cwd}}",
      "Current workspace: {{workspace}}",
      "Home: {{identity.home}}",
    ].join("\n"),
  "config/ai/profile/archivist/context.d/20-tooling.md":
    [
      "Archivist operating rules:",
      "- Your primary outputs are workspace continuity files under `.gsv/context.d/`.",
      "- Rewrite summaries cleanly instead of appending logs or leaving stale bullets behind.",
      "- Keep `10-summary.md` focused on current state, `20-open-loops.md` focused on unresolved items, and `30-decisions.md` focused on durable decisions or commitments.",
      "- Stage durable candidates under `~/knowledge/*/inbox/` only when they are likely to matter beyond the current run.",
      "- It is valid to stage nothing if the recent work contains no durable knowledge worth preserving.",
      "- Prefer direct filesystem tools for workspace context files.",
      "- Use `wiki` and `man` when they materially help you inspect or stage knowledge.",
      "- Avoid shell unless direct tools are insufficient.",
    ].join("\n"),
  "config/ai/profile/curator/context.d/00-role.md":
    [
      "You are the background curator process for {{identity.username}}.",
      "Your job is to review staged inbox candidates and decide whether they should become durable canonical knowledge.",
      "Act conservatively: promote, merge, defer, or discard based on clear evidence in the inbox note and current canonical pages.",
      "You are not a conversational assistant. Do not address the user directly.",
      "Prefer precise edits over broad rewrites and preserve inspectable markdown history.",
    ].join("\n"),
  "config/ai/profile/curator/context.d/10-runtime.md":
    [
      "Current working directory: {{identity.cwd}}",
      "Current workspace: {{workspace}}",
      "Home: {{identity.home}}",
    ].join("\n"),
  "config/ai/profile/curator/context.d/20-tooling.md":
    [
      "Curator operating rules:",
      "- Inspect inbox notes and canonical pages before changing anything.",
      "- Valid outcomes are: promote, merge, defer, or discard.",
      "- Promote or merge only when the target page is clear and the candidate is durable.",
      "- Leave uncertain candidates in inbox rather than guessing.",
      "- It is valid to make no changes if the inbox is empty or nothing is clear enough to promote.",
      "- Prefer `wiki` and direct filesystem inspection over broad shell usage.",
      "- Keep edits minimal and local to the candidate being reviewed.",
    ].join("\n"),
  // Max total bytes for ~/context.d/ files included in the prompt.
  "config/ai/max_context_bytes": "32768",

  // -- Server -----------------------------------------------------------------
  // Human-readable name for this GSV instance.
  "config/server/name": "gsv",
  // Timezone used for cron scheduling and log timestamps (IANA format).
  "config/server/timezone": "UTC",
  // The current server version (set at boot, read-only for users).
  "config/server/version": "0.1.0",

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

  // -- Automation -------------------------------------------------------------
  // Minimum time between archivist compaction jobs for the same scope in ms.
  "config/automation/archivist/min_interval_ms": "300000",
  // Interval between curator sweeps in ms. 0 disables periodic curator runs.
  "config/automation/curator/interval_ms": "3600000",
  // Maximum number of inbox candidates the curator should review in one run.
  "config/automation/curator/batch_size": "5",

  // Tool approval policy for agent tool execution. JSON object with a default
  // action and ordered rules matching exact syscalls or domain wildcards.
  "config/ai/profile/init/tools/approval": "{\"default\":\"auto\",\"rules\":[{\"match\":\"shell.exec\",\"action\":\"ask\"},{\"match\":\"fs.delete\",\"action\":\"ask\"}]}",
  "config/ai/profile/task/tools/approval": "{\"default\":\"auto\",\"rules\":[{\"match\":\"shell.exec\",\"action\":\"ask\"},{\"match\":\"fs.delete\",\"action\":\"ask\"}]}",
  "config/ai/profile/review/tools/approval": "{\"default\":\"auto\",\"rules\":[{\"match\":\"shell.exec\",\"action\":\"ask\"},{\"match\":\"fs.delete\",\"action\":\"ask\"}]}",
  "config/ai/profile/app/tools/approval": "{\"default\":\"auto\",\"rules\":[{\"match\":\"shell.exec\",\"action\":\"ask\"},{\"match\":\"fs.delete\",\"action\":\"ask\"}]}",
  "config/ai/profile/mcp/tools/approval": "{\"default\":\"auto\",\"rules\":[{\"match\":\"shell.exec\",\"action\":\"ask\"},{\"match\":\"fs.delete\",\"action\":\"ask\"}]}",
  "config/ai/profile/cron/tools/approval": "{\"default\":\"auto\",\"rules\":[{\"match\":\"fs.delete\",\"action\":\"deny\"},{\"match\":\"shell.exec\",\"action\":\"auto\"}]}",
  "config/ai/profile/archivist/tools/approval": "{\"default\":\"auto\",\"rules\":[{\"match\":\"fs.delete\",\"action\":\"deny\"},{\"match\":\"shell.exec\",\"action\":\"auto\"}]}",
  "config/ai/profile/curator/tools/approval": "{\"default\":\"auto\",\"rules\":[{\"match\":\"fs.delete\",\"action\":\"deny\"},{\"match\":\"shell.exec\",\"action\":\"auto\"}]}",
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
