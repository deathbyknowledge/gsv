# Configuration Reference

GSV configuration is a logical SQLite-backed key/value namespace. During the
current routing transition, both system-wide `config/` values and authoritative
per-user `users/{uid}/` values live in the Master Control Program named
`singleton`. Filtered values are copied into each active user Kernel as a
runtime projection. Keys are slash-separated strings and explicit overrides are
stored as strings.

After a successful authoritative write, `config/*` changes refresh every active
user Kernel, while `users/{uid}/*` changes refresh only that uid's active
placement. Targets pull the current filtered Master snapshot instead of applying
the invalidation payload, so delayed invalidations cannot restore stale values.
Connected user clients receive `config.changed` after their local projection is
current.

The v21 projection clock assigns the complete filtered snapshot a monotonic
Master revision and SHA-256 digest. A user Kernel rejects revision rollback and
different bytes under the same revision. Package-authority mutations use an
additional durable package fence and do not reopen package runtime admission
until active targets install the exact committed revision.

The combined authorized view is exposed through:

- `/sys/config/*` for system configuration.
- `/sys/users/{uid}/*` for user-scoped configuration.
- `sys.config.get` and `sys.config.set` for syscall clients.

Code defaults are overlaid at read time. An explicit authoritative value wins;
deleting it reveals the code default again. Prefix reads include readable
values plus matching defaults, with explicit values overriding defaults of the
same key.

## Access Model

Root (`uid 0`) can read and write all configuration. Active user Kernels forward
`sys.config.get` and `sys.config.set` to `singleton`; non-root users can read
their own `users/{uid}/*` keys and only a literal positive allowlist of reviewed
shared `config/*` keys. Every unknown system key is private by default, including
prefix listings; adding a ConfigStore default does not publish it.

Sensitive-name detection still recognizes final path segments such as
`api_key`, `secret`, `token`, `password`, `access_token`, `refresh_token`, and
`client_secret`, plus suffixes such as `_api_key`, `_secret`, `_token`, and
`_password`. That classification is defense in depth for masking and handling;
the absence of a sensitive-looking name never grants non-root read access.

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
| `config/ai/model` | `users/{uid}/ai/model` | `@cf/zai-org/glm-5.2` | Provider model identifier. |
| `config/ai/fallback_model_profile` | `users/{uid}/ai/fallback_model_profile` | `workers-ai-kimi-k2-6` | Saved model profile to try if the selected model fails. |
| `config/ai/api_key` | `users/{uid}/ai/api_key` | empty | Provider credential. Sensitive. |
| `config/ai/reasoning` | `users/{uid}/ai/reasoning` | `medium` | Reasoning mode hint: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. Unsupported values are clamped to the nearest model-supported level at generation time. |
| `config/ai/max_tokens` | `users/{uid}/ai/max_tokens` | `8192` | Maximum output tokens. |
| `config/ai/max_context_bytes` | `users/{uid}/ai/max_context_bytes` | `32768` | Prompt context budget before messages. |

## System and Profile Context

All AI profiles load shared system context first:

```text
config/ai/context.d/*.md
```

Built-in AI profiles then load role-specific context from:

```text
config/ai/profile/{profile}/context.d/*.md
```

Supported built-in profiles are `init`, `task`, `review`, `cron`, `mcp`, and `app`. Files are sorted lexically, empty files are skipped, and Markdown content is concatenated into the corresponding context section.

Use numeric prefixes to make ordering explicit:

```text
config/ai/context.d/00-gsv.md
config/ai/context.d/10-runtime.md
config/ai/profile/task/context.d/00-role.md
```

System and profile context support runtime template variables such as `profile`, `identity.uid`, `identity.username`, `identity.home`, `identity.cwd`, `identity.workspaceId`, `workspace`, `devices`, `mcpServers`, and `known_paths`.

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
    { "match": "sys.mcp.call", "action": "ask" },
    { "match": "fs.delete", "action": "deny" },
    { "match": "fs.*", "when": { "target": "device" }, "action": "ask" }
  ]
}
```

Actions are `auto`, `ask`, or `deny`. `match` accepts an exact syscall name or a domain wildcard such as `fs.*`. `when` can filter by `profile`, `anyProfile`, `anyTag`, `allTags`, `argEquals`, `argPrefix`, or `target` (`gsv` or `device`). Invalid or missing JSON falls back to the runtime default policy.

Default policies:

| Profiles | Default | Rules |
|---|---|---|
| `init`, `task`, `review`, `app`, `mcp` | `auto` | Ask for `shell.exec`, `fs.delete`, and `sys.mcp.call`. |
| `cron` | `auto` | Deny `fs.delete` and `sys.mcp.call`; allow `shell.exec`. |

## Runtime Config Keys

| Key | Default | Description |
|---|---|---|
| `config/server/name` | `gsv` | Server name used by hostname-style tools and package metadata. |
| `config/server/timezone` | `UTC` | Runtime timezone value. |
| `config/server/version` | current `VERSION` | Semantic server version exposed to runtime tools. |
| `config/shell/timeout_ms` | `30000` | Default native shell timeout. |
| `config/shell/network_enabled` | `true` | Enables network tools in native shell execution. |
| `config/shell/max_output_bytes` | `524288` | Maximum captured shell output. |
| `config/process/init_label` | `init ({username})` | Default init process label template. |
| `config/process/max_per_user` | `0` | Maximum processes per user. `0` means unlimited. |

The protocol's `server.version` is this semantic product version. `server.release`
identifies the deployed build: stable release bundles use their exact `vX.Y.Z` tag,
while local and dev builds report `dev`. The release identifier is build metadata,
not a writable configuration key.

## Package Config

Package-related config uses the same logical namespace while retaining the same
Master-versus-user ownership split:

| Key Pattern | Description |
|---|---|
| `users/{uid}/pkg/remotes/{name}` | User package catalog remotes managed by `pkg.remote.*`. |
| `config/pkg/public-repos/{owner}/{repo}` | Public package repo allowlist managed by `pkg.public.*`. |

## Practical Notes

All values are strings. Callers parse booleans and numbers at the point of use. Prefer user-scoped AI overrides for per-user model settings, and reserve system keys for defaults that should apply across the GSV instance.

## See also

- [CLI Commands](./cli-commands.md)
- [Context Files](./context-files.md)
- [Guides](../how-to/)
