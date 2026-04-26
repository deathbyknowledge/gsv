# Configuration Reference

GSV configuration is a SQLite-backed key/value store owned by the Kernel Durable Object. Keys are slash-separated strings and values are stored as strings. System-wide configuration lives under `config/`; per-user overrides live under `users/{uid}/`.

The same store is exposed through:

- `/sys/config/*` for system configuration.
- `/sys/users/{uid}/*` for user-scoped configuration.
- `sys.config.get` and `sys.config.set` for syscall clients.

Defaults are seeded when the Kernel starts, but only when a key is missing. Existing values are preserved.

## Access Model

Root (`uid 0`) can read and write all configuration. Non-root users can read their own `users/{uid}/*` keys and non-sensitive `config/*` keys. Sensitive system keys are hidden from non-root reads, including prefix listings.

Sensitive final path segments include `api_key`, `secret`, `token`, `password`, `access_token`, `refresh_token`, and `client_secret`. Suffixes such as `_api_key`, `_secret`, `_token`, and `_password` are also treated as sensitive.

`sys.config.set` lets non-root users write only their own `users/{uid}/ai/*` keys. System writes under `/sys/config/*` require root.

## Reading and Writing

Inside a GSV shell, use the filesystem view:

```sh
cat /sys/config/ai/provider
cat /sys/users/1000/ai/model
printf '%s\n' openai > /sys/users/1000/ai/provider
```

From an API or WebSocket client, use syscalls:

```json
{ "key": "config/ai" }
```

```json
{ "key": "users/1000/ai/model", "value": "gpt-4.1-mini" }
```

Reading a prefix returns every readable key below that prefix. Reading an exact key returns that key's value or fails if access is denied.

## AI Model Config

The AI runtime resolves per-user values first, then falls back to system defaults.

| System Key | User Override | Default | Description |
|---|---|---|---|
| `config/ai/provider` | `users/{uid}/ai/provider` | `workers-ai` | Provider adapter. |
| `config/ai/model` | `users/{uid}/ai/model` | `@cf/nvidia/nemotron-3-120b-a12b` | Provider model identifier. |
| `config/ai/api_key` | `users/{uid}/ai/api_key` | empty | Provider credential. Sensitive. |
| `config/ai/reasoning` | `users/{uid}/ai/reasoning` | `off` | Reasoning mode hint. |
| `config/ai/max_tokens` | `users/{uid}/ai/max_tokens` | `8192` | Maximum output tokens. |
| `config/ai/max_context_bytes` | `users/{uid}/ai/max_context_bytes` | `32768` | Prompt context budget before messages. |

## Profile Context

Built-in AI profiles load prompt context from:

```text
config/ai/profile/{profile}/context.d/*.md
```

Supported built-in profiles are `init`, `task`, `review`, `cron`, `mcp`, `app`, `archivist`, and `curator`. Files are sorted lexically, empty files are skipped, and Markdown content is concatenated into the profile context.

Use numeric prefixes to make ordering explicit:

```text
config/ai/profile/task/context.d/00-role.md
config/ai/profile/task/context.d/10-runtime.md
config/ai/profile/task/context.d/20-tooling.md
```

Profile context supports runtime template variables such as `profile`, `identity.uid`, `identity.username`, `identity.home`, `identity.cwd`, `identity.workspaceId`, `workspace`, `devices`, and `known_paths`.

## Tool Approval Policy

Each built-in profile has a JSON policy at:

```text
config/ai/profile/{profile}/tools/approval
```

Policy shape:

```json
{
  "default": "auto",
  "rules": [
    { "match": "shell.exec", "action": "ask" },
    { "match": "fs.delete", "action": "deny" },
    { "match": "fs.*", "when": { "target": "device" }, "action": "ask" }
  ]
}
```

Actions are `auto`, `ask`, or `deny`. `match` accepts an exact syscall name or a domain wildcard such as `fs.*`. `when` can filter by `profile`, `anyProfile`, `anyTag`, `allTags`, `argEquals`, `argPrefix`, or `target` (`gsv` or `device`). Invalid or missing JSON falls back to the runtime default policy.

Default policies:

| Profiles | Default | Rules |
|---|---|---|
| `init`, `task`, `review`, `app`, `mcp` | `auto` | Ask for `shell.exec` and `fs.delete`. |
| `cron`, `archivist`, `curator` | `auto` | Deny `fs.delete`; allow `shell.exec`. |

## Runtime Config Keys

| Key | Default | Description |
|---|---|---|
| `config/server/name` | `gsv` | Server name used by hostname-style tools and package metadata. |
| `config/server/timezone` | `UTC` | Runtime timezone value. |
| `config/server/version` | `0.1.0` | Server version value. |
| `config/shell/timeout_ms` | `30000` | Default native shell timeout. |
| `config/shell/network_enabled` | `true` | Enables network tools in native shell execution. |
| `config/shell/max_output_bytes` | `524288` | Maximum captured shell output. |
| `config/process/init_label` | `init ({username})` | Default init process label template. |
| `config/process/max_per_user` | `0` | Maximum processes per user. `0` means unlimited. |
| `config/automation/archivist/min_interval_ms` | `300000` | Minimum archivist interval. |
| `config/automation/curator/interval_ms` | `3600000` | Curator interval. `0` disables periodic curator runs. |
| `config/automation/curator/batch_size` | `5` | Maximum curator batch size. |

## Package Config

Package-related config is also stored in the same key/value store:

| Key Pattern | Description |
|---|---|
| `users/{uid}/pkg/remotes/{name}` | User package catalog remotes managed by `pkg.remote.*`. |
| `config/pkg/public-repos/{owner}/{repo}` | Public package repo allowlist managed by `pkg.public.*`. |

## Practical Notes

All values are strings. Callers parse booleans and numbers at the point of use. Prefer user-scoped AI overrides for per-user model settings, and reserve system keys for defaults that should apply across the GSV instance.
