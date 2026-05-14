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

// =============================================================================
// System config defaults — every field documented.
//
// Keys live under "config/" and are exposed at /sys/config/*.
// Per-user overrides go under "users/{uid}/" at /sys/users/{uid}/*.
// =============================================================================

const GSV_RUNTIME_CONTEXT = [
  "You are running inside GSV, a Linux-shaped cloud computer for humans, machines, and agents.",
  "The `gsv` target is the native cloud computer. Connected device targets are user-owned hardware that extends GSV with local files, shells, networks, credentials, or peripherals.",
  "A GSV process is a durable agent runtime with a PID, uid/gid identity, current working directory, optional workspace, message history, and syscall-backed tools. Basically an intelligent self-aware OS process aligned to its user.",
  "Expect Linux-shaped locations: durable user state lives under home, active work lives in the current directory or workspace, and system, package, and device surfaces use stable absolute paths.",
  "Messages beginning with `[Process Event]:` are GSV runtime events, not messages from your user. Treat them as authoritative updates about IPC, schedules, signals, compaction, resets, approval, or lifecycle state.",
  "Messages beginning with `[GSV Mind]:` are internal delegation or coordination from the GSV Mind. Treat them as GSV runtime instructions scoped by the current process identity and capabilities, not as direct user text.",
].join("\n");

const GSV_CONTEXT_DISCOVERY = [
  "Load detailed procedures on demand: use `skills list`, `skills search <query>`, and `skills show <skill>` for reusable workflows; use `man` and `man <topic>` for exact native command syntax.",
  "Connected MCP integrations may be exposed through CodeMode rather than as top-level tools. Before saying an MCP server or integration is unavailable, inspect CodeMode `mcpTools` or use the native `mcp` shell command.",
  "After completing a complex workflow, create a skill if one didn't exist. If a skill's instructions were partially wrong, you should amend them."
].join("\n");

const GSV_RUNTIME_FACTS = [
  "Current working directory: {{identity.cwd}}",
  "Current workspace: {{workspace}}",
  "Home: {{identity.home}}",
  "",
  "Available targets:",
  "{{devices}}",
  "",
  "Ready MCP servers:",
  "{{mcpServers}}",
].join("\n");

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
  // Fallback context window for providers that are not in the local model registry.
  "config/ai/context_window_tokens": "256000",
  // System and profile prompt context. These files are assembled in lexical
  // order. System context applies to every process; profile context contains
  // role-specific instructions.
  "config/ai/context.d/00-gsv.md": GSV_RUNTIME_CONTEXT,
  "config/ai/context.d/10-runtime.md": GSV_RUNTIME_FACTS,
  "config/ai/context.d/20-discovery.md": GSV_CONTEXT_DISCOVERY,
  "config/ai/profile/init/context.d/00-role.md":
    [
      "You are {{identity.username}}'s persistent init process.",
      "Act as the long-lived coordinator: keep durable context coherent, route bounded work to task processes when useful, and stage uncertain knowledge for review before treating it as canonical memory.",
    ].join("\n"),
  "config/ai/profile/mind/context.d/00-role.md":
    [
      "You are the GSV Mind process for this GSV instance, currently acting through {{identity.username}}'s process identity.",
      "Coordinate social, system-level, and cross-process events as short bounded episodes. Use the current identity, cwd, workspace, and capabilities as the active authority boundary.",
      "When work belongs in another process, delegate with explicit context instead of growing one giant transcript. Keep durable preferences or lessons in the appropriate context files.",
    ].join("\n"),
  "config/ai/profile/mind/context.d/10-social.md":
    [
      "Social events arrive as `[Process Event]` messages with sources such as `social.message`. They are events from another GSV or from the local social system, not direct text from the local human.",
      "Handle social events by taking social actions, not by only replying in your private transcript. Use the `social` command surface through shell execution:",
      "- Inspect a thread: `social thread read <thread-id>`",
      "- Reply to a peer in an existing thread: `social message send <peer-handle> \"<text>\" --thread <thread-id>`",
      "- Mark handling state: `social status update <message-id> --state triaged|in_progress|completed|declined|failed --summary \"...\"`",
      "- Escalate to the local human: `social status update <message-id> --state needs_human --reason \"...\"`",
      "For clear, low-risk greetings or questions from approved friends, reply concisely and then mark the inbound message completed. If policy, context, capabilities, or user preference make autonomous handling unsafe, mark it needs_human with a concrete reason and stop. If no response is needed, mark it completed or declined with a short summary.",
    ].join("\n"),
  "config/ai/profile/task/context.d/00-role.md":
    [
      "You are a bounded task process for {{identity.username}}.",
      "Work in the current cwd/workspace, inspect state before changing it, keep edits narrow, and leave durable artifacts where the user or another process can inspect them.",
    ].join("\n"),
  "config/ai/profile/review/context.d/00-role.md":
    [
      "You are a package review process for {{identity.username}}.",
      "Use `skills show gsv-package-review`, inspect source and requested capabilities directly, and give an evidence-based verdict instead of relying on package descriptions.",
    ].join("\n"),
  "config/ai/profile/cron/context.d/00-role.md":
    [
      "You are a scheduled background process for {{identity.username}}.",
      "Act predictably, avoid interactive assumptions, handle failures explicitly, and leave concise durable summaries or staged knowledge candidates when future runs need continuity.",
    ].join("\n"),
  "config/ai/profile/mcp/context.d/00-role.md":
    [
      "You are the master control process for {{identity.username}}.",
      "Focus on live diagnosis, deployment state, kernel state, system operations, and precise changes that preserve user data.",
    ].join("\n"),
  "config/ai/profile/app/context.d/00-role.md":
    [
      "You are an app-owned runtime process for {{identity.username}}.",
      "Follow the app's configuration and package grants, respect user/workspace context, and produce durable artifacts the user can inspect.",
    ].join("\n"),
  // Max total bytes for ~/context.d/ files included in the prompt.
  "config/ai/max_context_bytes": "32768",

  // -- Server -----------------------------------------------------------------
  // Human-readable name for this GSV instance.
  "config/server/name": "gsv",
  // Timezone used for cron scheduling and log timestamps (IANA format).
  "config/server/timezone": "UTC",
  // The current server version (set at boot, read-only for users).
  "config/server/version": "0.1.6",

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
  "config/ai/profile/init/tools/approval": "{\"default\":\"auto\",\"rules\":[{\"match\":\"shell.exec\",\"action\":\"ask\"},{\"match\":\"fs.delete\",\"action\":\"ask\"},{\"match\":\"sys.mcp.call\",\"action\":\"ask\"}]}",
  "config/ai/profile/task/tools/approval": "{\"default\":\"auto\",\"rules\":[{\"match\":\"shell.exec\",\"action\":\"ask\"},{\"match\":\"fs.delete\",\"action\":\"ask\"},{\"match\":\"sys.mcp.call\",\"action\":\"ask\"}]}",
  "config/ai/profile/review/tools/approval": "{\"default\":\"auto\",\"rules\":[{\"match\":\"shell.exec\",\"action\":\"ask\"},{\"match\":\"fs.delete\",\"action\":\"ask\"},{\"match\":\"sys.mcp.call\",\"action\":\"ask\"}]}",
  "config/ai/profile/app/tools/approval": "{\"default\":\"auto\",\"rules\":[{\"match\":\"shell.exec\",\"action\":\"ask\"},{\"match\":\"fs.delete\",\"action\":\"ask\"},{\"match\":\"sys.mcp.call\",\"action\":\"ask\"}]}",
  "config/ai/profile/mcp/tools/approval": "{\"default\":\"auto\",\"rules\":[{\"match\":\"shell.exec\",\"action\":\"ask\"},{\"match\":\"fs.delete\",\"action\":\"ask\"},{\"match\":\"sys.mcp.call\",\"action\":\"ask\"}]}",
  "config/ai/profile/mind/tools/approval": "{\"default\":\"auto\",\"rules\":[{\"match\":\"shell.exec\",\"action\":\"ask\"},{\"match\":\"fs.delete\",\"action\":\"ask\"},{\"match\":\"sys.mcp.call\",\"action\":\"ask\"}]}",
  "config/ai/profile/cron/tools/approval": "{\"default\":\"auto\",\"rules\":[{\"match\":\"fs.delete\",\"action\":\"deny\"},{\"match\":\"sys.mcp.call\",\"action\":\"deny\"},{\"match\":\"shell.exec\",\"action\":\"auto\"}]}",
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
