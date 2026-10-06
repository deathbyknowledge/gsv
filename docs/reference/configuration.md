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

`sys.config.set` lets non-root users write `ai/*`, `ui/*`, and `locale/*` preferences for their own or delegated accounts. System writes under `/sys/config/*` require root.

`users/{ownerUid}/locale/timezone` is the human's IANA timezone, for example `Europe/Amsterdam`. Ship's context and new schedules without an explicit timezone use this preference, falling back to `config/server/timezone` and then UTC. Existing schedules retain their saved timezone, and system crontabs retain their system/`CRON_TZ` semantics. Invalid personal timezones are rejected; clearing the preference restores the installation default. The Instrument preference does not change the browser's formatting timezone.

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

Text models resolve as one ordered stack built from three layers:

1. The owner's own list at `users/{ownerUid}/ai/models`.
2. The installation-wide list at `config/ai/models`, which root manages.
3. The deployment base, which needs no configuration: **GSV Included** on managed installations and the Workers AI pair (GLM 5.3 Flash, then Kimi K2.6) on self-hosted ones.

Each layer extends the ones below it; nothing replaces the base. The first entry of the combined stack is primary and every later entry is tried in order after an eligible provider failure. An entry is skipped when an earlier layer already has the same id or the same provider, model, endpoint, API style, and transport target, so a personal copy of a base model appears once. Setup writes nothing unless the user explicitly chooses a model, and choosing GSV Included writes nothing because it is already the base. `ai.models` returns the effective stack with each entry's layer and whether it has a stored credential, never the credential itself.

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

The owner may order models across all three layers through `users/{ownerUid}/ai/model_order`, a JSON array of stable IDs such as `["gsv-included", "primary"]`. This changes only the order: model definitions and credentials remain in their original scope. Unavailable IDs are skipped, and models absent from the array follow in their layered order. New or updated inherited definitions remain live. Clearing the setting restores layered order. `ai.models` keeps `models` in configured layer order for clients that edit definitions and returns the optional `modelOrder` separately.

An agent, Process, or the owner may prefer an entry from any layer by its stable ID through `users/{uid}/ai/preferred_model` or a Process-local AI configuration. The preferred entry moves to the front of the owner's ordered stack; the remaining models retain their order. An owner's preference is the default for every agent that owner runs; an agent's own `preferred_model` overrides it for that agent alone. The owner's `model_order` applies to all of its processes, including ones running as an agent account. Reasoning remains an orthogonal preference. Request-local validation also supplies one complete model configuration; it cannot merge individual provider fields into a stored entry. It may reference the credential attached to a stable entry only while the provider, model, endpoint, API style, and transport target still match that entry.

| System Key | User Override | Default | Description |
|---|---|---|---|
| `config/ai/models` | `users/{ownerUid}/ai/models` | none; the deployment base applies beneath both | Ordered complete text-model entries that extend the deployment base. |
| — | `users/{ownerUid}/ai/model_order` | none; layered order applies | JSON array of stable IDs defining the owner's fallback order across personal, system and base models. |
| — | `users/{uid}/ai/preferred_model` | empty | Stable entry ID preferred by this account. An owner's choice applies to the agents it runs unless an agent sets its own. |
| `config/ai/reasoning` | `users/{uid}/ai/reasoning` | `medium` | Reasoning mode hint: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. Unsupported values are clamped to the nearest model-supported level at generation time. |
| `config/ai/max_context_bytes` | `users/{uid}/ai/max_context_bytes` | `32768` | Prompt context budget before messages. |
| `config/ai/skills/index_mode` | `users/{uid}/ai/skills/index_mode` | `summary` | Skill index included in standing context: ids and descriptions with `summary`, ids only with `names`, or omitted with `off`. Live discovery remains available in every mode. |
| `config/ai/generation/timeout_ms` | `users/{uid}/ai/generation/timeout_ms` | `180000` | Maximum time to wait for one model generation before the run is released. |
| `config/ai/generation/streaming` | `users/{uid}/ai/generation/streaming` | `auto` | `auto` streams when the provider supports it; `off` forces final-output only. |

Without an explicit `contextWindowTokens`, the Kernel resolves the model's
context limit through the inference service. Each lookup waits at most ten
seconds, capped by a shorter generation timeout. Successful metadata is cached
in that Kernel for one minute (up to 64 provider/model pairs); failures and
late replies are not cached. A routing change can therefore take up to a minute
to appear in newly resolved configuration. An active run retains its resolved
configuration. Generation admission, permissions, credentials and usage checks
remain independent of this metadata cache.

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

The approval policy decides whether an agent's tool call runs, asks the person
first, or is refused. Two keys hold it:

| Key | Scope | Edited at |
|---|---|---|
| `config/ai/tools/approval` | Installation default, root-writable | `/sys/config/ai/tools/approval` |
| `users/{uid}/ai/tools/approval` | One account's override, layered over the default | **Settings → permissions** in the web console, or `/sys/users/{uid}/ai/tools/approval` |

Policy shape:

```json
{
  "default": "auto",
  "rules": [
    { "match": "shell.exec", "action": "ask" },
    { "match": "fs.*", "target": "targets/*", "action": "ask" },
    { "match": "fs.delete", "action": "deny" },
    { "match": "mail.send", "action": "auto" }
  ]
}
```

- `action` is `auto`, `ask`, or `deny`. The console labels them **Allow**, **Ask**, and **Block**.
- `match` is an exact syscall name or a domain wildcard ending in `.*`; `fs.*` matches `fs` and every `fs.` call.
- `target` scopes a rule to where the call runs. Omit it, or use `*` or `any`, for every target. `gsv` is the cloud home (`gateway` and `local` are aliases). `targets/*` is any connected machine or browser. A bare target id scopes the rule to that one target. The legacy values `device` and `devices/*` are read as `targets/*`, and a legacy `when: { "target": ... }` object is read as `target`; nothing else inside `when` is honoured.
- Precedence: the rule with the most specific target wins, then an exact `match` beats a wildcard, then list order. A rule that fails validation is dropped; a value that is not valid JSON falls back to the built-in default.

For a call, the target is resolved before matching: `fs.*`, `shell.exec`, and `net.fetch` use the call's `target` argument; a `shell.exec` carrying a `sessionId` resolves to `targets/*`; every other syscall resolves to `gsv`.

Default policy (`default` is `auto`; the runtime, the Process fallback, and the permissions editor share this one definition in `@humansandmachines/gsv/protocol`):

| Where | Runs automatically | Asks first |
|---|---|---|
| `gsv`, the cloud home | `fs.*`, `shell.exec`, `net.fetch` | — |
| `targets/*`, connected computers and browsers | `fs.read`, `fs.search`, `fs.transfer.stat`, `fs.transfer.send` | every other `fs.*` call, `shell.exec`, `net.fetch` |
| any target | `web.search` | `sys.mcp.call`, `mail.send` |

So native work in the cloud home and reads or searches on a connected target proceed without asking; changing files, running commands, or making network requests on a connected target asks first. Capability grants and resource checks still apply on top.

A stored policy may leave either field out. An omitted `default` is `auto`, and an omitted `rules` keeps the built-in rules above, so `{"default":"deny"}` alone still runs native cloud-home work automatically. To replace every built-in rule, set `rules` explicitly, using `[]` for none. A value that is not valid JSON, or not an object, falls back to the built-in policy.

Mail is guarded separately. When `default` is `auto` and no rule covers `mail.send` at the `gsv` scope, an `ask` rule for `mail.send` is added to the policy on read, and an unmatched `mail.send` resolves to `ask` regardless. Sending mail without asking requires an explicit `auto` rule for `mail.send`, as the permissions page says.

Every capability tool also accepts a `purpose` argument: one sentence written for the person, shown in the approval prompt and recorded in the ledger. It is stripped before the syscall runs; see [Tool purpose](./syscalls.md#tool-purpose).

### Always allow and the approval explanation

The web console writes an account override from the approval card in two ways, both as ordinary rules of the shape above. Each writes the policy of the account the requesting process resolves: the run-as account's own override when it has one, else its owner's. That holds when root is looking at another person's work. Neither is offered unless the person can change settings (`sys.config.set`) and **Settings → permissions** can edit the policy without loss.

- **Always allow** writes `{ "match": "<syscall>", "target": "<resolved target>", "action": "auto" }` for exactly the call being asked about, then approves that request once. Its tooltip names the scope, such as *run commands on my mac*. A rule for one machine wins over `targets/*`. On `mail.send` it is the explicit Allow rule that lets mail send without asking.
- **why am I being asked?** adds a short Ship message below the request, authored by the client rather than the model, and a box asking whether to stop asking. **Yes, turn on auto-approve for everything** sets every kind below to allow and the policy's `default` to `auto`, so calls outside those kinds stop asking too. **Only ask before deleting something or contacting someone** does the same except deleting files and sending email stay on ask. **What are sensitive tasks?** lists what the Ship asks about today and offers one choice, **allow** or **ask**, for each kind of action: running commands on your machines (`shell.exec` on `targets/*`), changing files on your machines (`fs.*` on `targets/*`), deleting files (`fs.delete` on `gsv` and on `targets/*`), fetching web pages through your machines (`net.fetch` on `targets/*`), connected tools (`sys.mcp.call`) and sending email (`mail.send` on `gsv`). Each row starts on what the policy does today. Saving writes rules only for the rows the person changed, starting from the current override, or the inherited policy when there is none. A choice also updates matching rules for one machine; picking the choice already shown keeps mixed per-machine settings. Existing Block rules stay blocked, file-change choices keep separate read, transfer and delete rules, and the per-kind list never changes `default`. **No, keep asking.** closes the box. A saved answer that now allows the pending call approves that request too.

Ordinary approve and deny decide one request only. A saved rule shows in **Settings → permissions**, where it can be changed or removed, and takes effect from the process's next run; the current run keeps the policy it started with. Because the override replaces the installation default rather than layering over it, an account that has saved keeps the rules it composed even if the installation default changes later.

The `remember` field of `proc.hil` still exists for other clients: it keeps an Allow rule for that call in the requesting process only, never in an account policy. The web console does not send it.

## Runtime Config Keys

| Key | Default | Description |
|---|---|---|
| `config/server/name` | `gsv` | Server name used by hostname-style tools and client metadata. |
| `config/server/timezone` | `UTC` | Runtime timezone value. |
| `config/server/version` | current `VERSION` | Semantic server version exposed to runtime tools. |
| `config/shell/timeout_ms` | `120000` | Default native shell timeout. |
| `config/shell/network_enabled` | `true` | Enables network tools in native shell execution. |
| `config/shell/max_output_bytes` | `524288` | Maximum stdout and stderr returned per `shell.exec`; bytes that only flow between pipeline stages or into files are not counted. |

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
