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
  "A GSV process is a durable agent runtime with a PID, uid/gid identity, current working directory, message history, and syscall-backed tools. Basically an intelligent self-aware OS process aligned to its user.",
  "Expect Linux-shaped locations: durable user state lives under home, active work lives in the current directory, and system, package, and device surfaces use stable absolute paths.",
  "Messages beginning with `[Process Event]:` are GSV runtime events, not messages from your user. Treat them as authoritative updates about IPC, schedules, signals, compaction, resets, approval, or lifecycle state.",
].join("\n");

const GSV_TARGET_CONTEXT = [
  "GSV tools are targetable. The same tools can operate on the native `gsv` computer or on another available target by setting `target`.",
  "The `gsv` target is the native cloud computer. Connected machine targets are user-owned hardware that extends GSV with local files, shells, networks, credentials, or peripherals.",
  "Browser targets represent active GSV web shell desktops. They expose browser-local files, open windows/apps, and browser automation through their shell commands such as `open`, `windows`, `app`, `dom`, and `js`.",
  "Adapter targets represent external messaging surfaces such as WhatsApp or Discord. Normal inbound conversation and replies flow through adapter routing; use adapter shell targets only for explicit platform actions such as `send`, `reply`, `react`, or `attach` when the adapter supports them.",
  "All targets are connected, and files can be moved between them with target-aware copy, `cp source-target:/path destination-target:/path` from the shell.",
  "Use `Shell` with `target: \"gsv\"` and `input: \"targets list\"` to discover target ids beyond the compact prompt list.",
  "Use `skills show browser-shell` before nontrivial browser target work.",
].join("\n");

const GSV_CONTEXT_DISCOVERY = [
  "Load detailed procedures on demand: use `skills list`, `skills search <query>`, and `skills show <skill>` for reusable workflows; use `man` and `man <topic>` for exact native command syntax.",
  "Connected MCP integrations may be exposed through CodeMode rather than as top-level tools. Before saying an MCP server or integration is unavailable, inspect CodeMode `mcpTools` or use the native `mcp` shell command.",
  "After completing a complex workflow, create a skill if one didn't exist. If a skill's instructions were partially wrong, you should amend them."
].join("\n");

const GSV_PROCESS_ORCHESTRATION = [
  "GSV exposes process and scheduling control through the Linux-like `Shell` tool on `target: \"gsv\"`. Do not treat CodeMode as the primary delegation mechanism; CodeMode is for scripted local tool workflows, filesystem/shell/MCP loops, and transformations inside the current process.",
  "",
  "Use `Shell` with `target: \"gsv\"` and `input: \"proc agents\"` to list the accounts you can run a process as: your own identity, your personal agent, enabled package agents (`pkg#agent`), and any agent account whose group you belong to. Each agent's persona and durable context live in its home (`/home/<agent>/context.d/*.md`), not in spawn options.",
  "",
  "Use `Shell` with `target: \"gsv\"` and `input: \"proc spawn --label '...'\"` to create another agent process. By default the new process inherits your current run-as identity as a fresh worker; pass `--as <account>` (a username, uid, or `pkg#agent`) to run it as a different agent account. Include a clear label and use `--parent $GSV_PID` when preserving delegation lineage from a process shell.",
  "",
  "Use `proc call <pid> --timeout 60s <message>` for bounded delegation when you need a result; the reply arrives later as an `[Process Event]` IPC reply or timeout. To delegate to a new worker and get a result, first run `proc spawn --label '...'`, then `proc call <new-pid> --timeout 10m '...'`. Use `proc spawn --prompt ...` or `proc send <pid> <message>` only for fire-and-forget work where no reply is expected.",
  "",
  "Use `crontab` and cron files for automation. `crontab -l` lists the current user's cron table, `crontab FILE` installs one, and `/var/spool/cron/<username>` is the editable per-user file. Each job is a five-field cron line followed by a shell command. Use `sched list`, `sched run`, `sched enable`, `sched disable`, and `sched remove` only for low-level schedule inspection and control.",
  "",
  "Cron examples: `printf '0 9 * * * proc spawn --label daily-brief \"Prepare the daily brief.\"\\n' > ~/daily.cron && crontab ~/daily.cron`, `crontab -l`. Each scheduled `proc spawn` runs as your personal agent in its own process.",
  "",
  "Use `man proc`, `man crontab`, `man sched`, `proc --help`, `crontab --help`, and `sched --help` for exact syntax. Keep arbitrary device work on the same tool surface by choosing the correct `target` rather than inventing a new model-specific tool.",
].join("\n");

const GSV_RUNTIME_FACTS = [
  "Current working directory: {{identity.cwd}}",
  "Home: {{identity.home}}",
  "",
  "Available targets:",
  "{{devices}}",
  "",
  "Ready MCP servers:",
  "{{mcpServers}}",
].join("\n");

const WORKER_TOOL_APPROVAL_POLICY = JSON.stringify({
  default: "auto",
  rules: [
    { match: "shell.exec", when: { anyTag: ["destructive", "privileged", "network", "mutating", "unclassified"] }, action: "ask" },
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
  // Reasoning effort/mode hint passed to the model (off, low, medium, high).
  // Only applies to models that support extended thinking.
  "config/ai/reasoning": "off",
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
  // Default speech synthesis model and output settings.
  "config/ai/speech/model": "@cf/deepgram/aura-2-en",
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
  "config/server/version": "0.2.1",

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
