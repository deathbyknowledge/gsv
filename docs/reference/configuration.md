# Configuration Reference

GSV configuration is a SQLite-backed key/value store owned by the Kernel Durable Object. Keys are slash-separated strings and explicit overrides are stored as strings. System-wide configuration lives under `config/`; per-user overrides live under `users/{uid}/`.

The same store is exposed through:

- `/sys/config/*` for system configuration.
- `/sys/users/{uid}/*` for user-scoped configuration.
- `sys.config.get` and `sys.config.set` for syscall clients.

Code defaults are overlaid at read time. An explicit SQLite value wins; deleting that explicit value reveals the code default again. Prefix reads include both explicit values and matching defaults, with explicit values overriding default entries of the same key.

## Access Model

Root (`uid 0`) can read and write all configuration. Non-root users can read their own `users/{uid}/*` keys and non-sensitive `config/*` keys. Sensitive system keys are hidden from non-root reads, including prefix listings.

Sensitive final path segments include `api_key`, `secret`, `token`, `password`, `access_token`, `refresh_token`, and `client_secret`. Suffixes such as `_api_key`, `_secret`, `_token`, and `_password` are also treated as sensitive.

`sys.config.set` lets non-root users write only their own `users/{uid}/ai/*` keys. System writes under `/sys/config/*` require root.

## Reading and Writing

Inside a GSV shell, use the filesystem view:

```sh
cat /sys/config/ai/models
cat /sys/users/1000/ai/models
printf '%s\n' '{"version":1,"models":[{"id":"primary","name":"Primary","provider":"openai","model":"gpt-5.4"}]}' > /sys/users/1000/ai/models
```

From an API or WebSocket client, use syscalls:

```json
{ "key": "config/ai" }
```

```json
{ "key": "users/1000/ai/preferred_model", "value": "primary" }
```

Reading a prefix returns every readable key below that prefix. Reading an exact key returns that key's value or fails if access is denied.

## AI Model Config

The owner controls one ordered list of complete text-model entries at `users/{ownerUid}/ai/models`. The first entry is primary and every later entry is tried in order after an eligible provider failure. If an owner has no list, `config/ai/models` supplies the system stack.

```json
{
  "version": 1,
  "models": [
    {
      "id": "primary",
      "name": "Primary",
      "provider": "openai",
      "model": "gpt-5.4",
      "maxTokens": 32768,
      "contextWindowTokens": 256000
    }
  ]
}
```

`id`, `name`, `provider`, and `model` are required. `baseUrl`, `providerStyle`, `transportTarget`, `maxTokens`, and `contextWindowTokens` are optional entry properties. A credential is stored separately at `users/{ownerUid}/ai/models/{id}/api_key` (or `config/ai/models/{id}/api_key` for a system entry), so list reads never expose it. The config store retains that credential across renames, ordering, and policy changes, but clears it when the entry's provider, model, endpoint, API style, or transport target changes.

An agent or Process may prefer an entry by its stable ID through `users/{uid}/ai/preferred_model` or its Process-local AI configuration. The preferred entry moves to the front for that Process; the rest of the owner's list retains its order. Reasoning remains an orthogonal preference. Request-local validation also supplies one complete model configuration; it cannot merge individual provider fields into a stored entry. It may reference the credential attached to a stable entry only while the provider, model, endpoint, API style, and transport target still match that entry.

| System Key | User Override | Default | Description |
|---|---|---|---|
| `config/ai/models` | `users/{ownerUid}/ai/models` | Workers AI primary plus fallback | Ordered complete text-model stack. |
| — | `users/{uid}/ai/preferred_model` | empty | Stable entry ID preferred by this agent account. |
| `config/ai/reasoning` | `users/{uid}/ai/reasoning` | `medium` | Reasoning mode hint: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. Unsupported values are clamped to the nearest model-supported level at generation time. |
| `config/ai/max_context_bytes` | `users/{uid}/ai/max_context_bytes` | `32768` | Prompt context budget before messages. |
| `config/ai/skills/index_mode` | `users/{uid}/ai/skills/index_mode` | `summary` | Skill index included in standing context: ids and descriptions with `summary`, ids only with `names`, or omitted with `off`. Live discovery remains available in every mode. |

Image generation, transcription, and speech each own a separate complete configuration under `config/ai/{capability}` or `users/{uid}/ai/{capability}`. Setting any user-scoped provider, model, credential, or speaker selects that whole scope; provider and model must both be present, and missing values are not borrowed from the text stack or system capability configuration. Their `api_key` values belong only to that capability configuration.

Legacy per-field text-model keys and `model_profiles` are not read. Move each connection into the ordered `models` stack before upgrading.

## System Context

```text
config/ai/context.d/*.md
```

Files are sorted lexically, empty files are skipped, and Markdown content is concatenated into the corresponding context section.

Use numeric prefixes to make ordering explicit:

```text
config/ai/context.d/00-runtime.md
config/ai/context.d/01-gsv.md
```

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
| Interactive processes | `auto` | Ask for `shell.exec`, `fs.delete`, and `sys.mcp.call`. |
| `cron` | `auto` | Deny `fs.delete` and `sys.mcp.call`; allow `shell.exec`. |

## Runtime Config Keys

| Key | Default | Description |
|---|---|---|
| `config/server/name` | `gsv` | Server name used by hostname-style tools and client metadata. |
| `config/server/timezone` | `UTC` | Runtime timezone value. |
| `config/server/version` | current `VERSION` | Semantic server version exposed to runtime tools. |
| `config/shell/timeout_ms` | `120000` | Default native shell timeout. |
| `config/shell/network_enabled` | `true` | Enables network tools in native shell execution. |
| `config/shell/max_output_bytes` | `524288` | Maximum captured shell output. |
| `config/process/max_per_user` | `0` | Maximum processes per user. `0` means unlimited. |

The protocol's `server.version` is this semantic product version. `server.release`
identifies the deployed build: stable release bundles use their exact `vX.Y.Z` tag,
while local and dev builds report `dev`. The release identifier is build metadata,
not a writable configuration key.

## Practical Notes

Top-level configuration values are strings; structured values such as the model stack are JSON strings. Prefer the owner-scoped model stack and reserve system keys for defaults that should apply across the GSV instance.

## See also

- [CLI Commands](./cli-commands.md)
- [Context Files](./context-files.md)
- [Guides](../how-to/)
