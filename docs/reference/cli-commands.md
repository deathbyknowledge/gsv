# CLI Command Reference

The `gsv` binary is the command-line interface for the GSV platform. It operates as a chat client, a tool-providing node, and a deployment manager.

## Global Options

These options apply to all subcommands that connect to the gateway.

| Option | Type | Env Var | Default | Description |
|--------|------|---------|---------|-------------|
| `-u`, `--url` | `string` | `GSV_URL` | `ws://localhost:8787/ws` | Gateway WebSocket URL. Overrides the config file value. |
| `-t`, `--token` | `string` | `GSV_TOKEN` | *(none)* | Auth token sent during the `connect` handshake. Overrides the config file value. |

Resolution order for `--url`: CLI flag > `GSV_URL` env > `gateway.url` in config > `ws://localhost:8787/ws`.

Resolution order for `--token`: CLI flag > `GSV_TOKEN` env > `gateway.token` in config.

---

## Configuration

Config file location: `~/.config/gsv/config.toml`

The file is TOML-formatted with the following sections:

| Section | Keys | Description |
|---------|------|-------------|
| `[gateway]` | `url`, `token` | Gateway connection settings |
| `[cloudflare]` | `account_id`, `api_token` | Cloudflare API credentials for deploy commands |
| `[r2]` | `account_id`, `access_key_id`, `secret_access_key`, `bucket` | R2 storage credentials for mount command |
| `[node]` | `id`, `workspace` | Default node ID and workspace directory |
| `[session]` | `default_key` | Default session key (default: `agent:main:cli:dm:main`) |
| `[channels.whatsapp]` | `url`, `token` | WhatsApp channel worker URL and auth token |

---

## gsv init

Initialize the CLI config file.

```
gsv init [--force]
```

Creates `~/.config/gsv/config.toml` with a sample configuration. If the file already exists, the command exits without changes unless `--force` is specified.

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--force` | `bool` | `false` | Overwrite existing config file |

---

## gsv client

Send a message to the agent.

```
gsv client [MESSAGE] [-s SESSION]
```

When `MESSAGE` is provided, sends a single message and waits up to 120 seconds for the agent response (one-shot mode). When omitted, enters interactive mode with a `>` prompt. Type `quit` or `exit` to leave interactive mode.

Connects to the gateway as a `client` mode WebSocket. Listens for `chat` events filtered by the active session key.

| Argument/Flag | Type | Default | Description |
|---------------|------|---------|-------------|
| `message` | `string` | *(none)* | Message to send. Omit for interactive mode. |
| `-s`, `--session` | `string` | Config `session.default_key` or `agent:main:cli:dm:main` | Session key to use. |

The session key is normalized: empty strings and the literal `"main"` resolve to `agent:main:cli:dm:main`.

---

## gsv node

Run a tool-providing node.

```
gsv node [--foreground] [--id ID] [--workspace PATH]
gsv node <SUBCOMMAND>
```

When invoked without a subcommand or `--foreground`:
- If the daemon service is already installed, starts (or restarts) it.
- If not installed, runs `gsv node install` implicitly.

When invoked with `--foreground`, runs the node in the current process with automatic reconnection. The node registers tools (Bash, Read, Write, Edit, Glob, Grep) and responds to `tool.invoke`, `logs.get`, and `node.probe` events from the gateway.

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--foreground` | `bool` | `false` | Run node in the current process instead of as a daemon. Cannot be combined with subcommands. |
| `--id` | `string` | Config `node.id`, or `node-<hostname>` | Node ID. Used as a namespace prefix for tools on the gateway. |
| `--workspace` | `path` | Config `node.workspace`, or current directory | Root directory for file-system tools. |

Node ID resolution order: `--id` flag > `node.id` in config > `node-<hostname>`.

Workspace resolution order: `--workspace` flag > `node.workspace` in config > current working directory.

Keepalive: the node sends a `tools.list` request every 5 minutes. If the keepalive fails or times out (10s), the node reconnects after 3 seconds.

Logs are written to `~/.gsv/logs/node.log` with rotation (default 10 MB max, 5 rotated files). Controlled by `GSV_NODE_LOG_MAX_BYTES` and `GSV_NODE_LOG_MAX_FILES` environment variables.

### gsv node install

Install and start the node daemon service.

```
gsv node install [--id ID] [--workspace PATH]
```

On macOS, installs a launchd agent (`dev.gsv.node`) at `~/Library/LaunchAgents/dev.gsv.node.plist`. On Linux, installs a systemd user unit (`gsv-node.service`). The service runs `gsv node --foreground` and restarts automatically.

Saves `--id` and `--workspace` to local config.

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--id` | `string` | *(same as `gsv node`)* | Node ID to save to config. |
| `--workspace` | `path` | *(same as `gsv node`)* | Workspace directory to save to config. |

### gsv node uninstall

Uninstall and stop the node daemon service.

```
gsv node uninstall
```

Removes the launchd plist (macOS) or systemd unit (Linux) and stops the running service.

### gsv node start

Start the node daemon service.

```
gsv node start
```

Starts the previously installed daemon. On macOS uses `launchctl kickstart`; on Linux uses `systemctl --user start`.

### gsv node stop

Stop the node daemon service.

```
gsv node stop
```

### gsv node status

Show the node daemon service status.

```
gsv node status
```

On macOS uses `launchctl print`; on Linux uses `systemctl --user status`.

### gsv node logs

Show node daemon log output.

```
gsv node logs [-n LINES] [--follow]
```

Reads from `~/.gsv/logs/node.log` using `tail`.

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-n`, `--lines` | `integer` | `100` | Number of lines to show. |
| `--follow` | `bool` | `false` | Follow log output (`tail -F`). |

---

## gsv config

Get or set gateway (remote) configuration.

Sends `config.get` or `config.set` RPC requests to the gateway over WebSocket.

### gsv config get

```
gsv config get [PATH]
```

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `path` | `string` | *(none)* | Dot-separated config path (e.g., `apiKeys.anthropic`, `model.provider`). If omitted, returns the full config. |

### gsv config set

```
gsv config set <PATH> <VALUE>
```

The value is parsed as JSON first; if parsing fails, it is treated as a plain string.

| Argument | Type | Description |
|----------|------|-------------|
| `path` | `string` | Dot-separated config path. |
| `value` | `string` | Value to set. |

---

## gsv local-config

Get or set local CLI configuration (`~/.config/gsv/config.toml`).

### gsv local-config show

```
gsv local-config show
```

Prints the full local config as TOML.

### gsv local-config get

```
gsv local-config get <KEY>
```

Valid keys: `gateway.url`, `gateway.token`, `cloudflare.account_id`, `cloudflare.api_token`, `r2.account_id`, `r2.access_key_id`, `r2.bucket`, `session.default_key`, `node.id`, `node.workspace`.

Tokens and secrets are masked in output.

### gsv local-config set

```
gsv local-config set <KEY> <VALUE>
```

Valid keys: `gateway.url`, `gateway.token`, `cloudflare.account_id`, `cloudflare.api_token`, `r2.account_id`, `r2.access_key_id`, `r2.secret_access_key`, `r2.bucket`, `session.default_key`, `node.id`, `node.workspace`, `channels.whatsapp.url`, `channels.whatsapp.token`.

Setting `session.default_key` normalizes the value (empty or `"main"` becomes `agent:main:cli:dm:main`).

### gsv local-config path

```
gsv local-config path
```

Prints the config file path and whether it exists.

---

## gsv deploy

Cloudflare deployment commands. Manages worker deployment via the Cloudflare API.

Valid components: `gateway`, `channel-whatsapp`, `channel-discord`.

### gsv deploy up

Deploy prebuilt Cloudflare bundles.

```
gsv deploy up [flags]
```

Fetches prebuilt bundles from GitHub releases (or a local directory), then deploys them as Cloudflare Workers. Creates the shared R2 bucket (`gsv-storage`) if it does not exist. Optionally bootstraps gateway configuration (auth token, LLM provider/model/key) via WebSocket after deploy.

| Flag | Type | Env Var | Default | Description |
|------|------|---------|---------|-------------|
| `--version` | `string` | | `latest` | Release tag (e.g., `v0.2.0`) or `"latest"`. |
| `-c`, `--component` | `string` (repeatable) | | *(all)* | Component to include. Repeat for multiple. |
| `--all` | `bool` | | `false` | Include all components. Mutually exclusive with `--component`. |
| `--force-fetch` | `bool` | | `false` | Overwrite existing extracted bundle directories. |
| `--bundle-dir` | `path` | | *(none)* | Use local bundle directory instead of downloading from GitHub. |
| `--wizard` | `bool` | | `false` | Run interactive setup prompts. Requires an interactive terminal. |
| `--api-token` | `string` | `CF_API_TOKEN` | Config `cloudflare.api_token` | Cloudflare API token. |
| `--account-id` | `string` | `CF_ACCOUNT_ID` | Config `cloudflare.account_id` | Cloudflare account ID. |
| `--gateway-auth-token` | `string` | `GSV_GATEWAY_AUTH_TOKEN` | *(none)* | Auth token to set in gateway config (`auth.token`). |
| `--llm-provider` | `string` | | *(none)* | LLM provider (`anthropic`, `openai`, `google`, `openrouter`, or custom). |
| `--llm-model` | `string` | | Provider default | LLM model ID. |
| `--llm-api-key` | `string` | | Provider env var | LLM API key. |
| `--discord-bot-token` | `string` | `DISCORD_BOT_TOKEN` | *(none)* | Discord bot token to upload as worker secret. |

Default models by provider:

| Provider | Default Model |
|----------|---------------|
| `anthropic` | `claude-sonnet-4-20250514` |
| `openai` | `gpt-4.1` |
| `google` | `gemini-2.5-flash` |
| `openrouter` | `anthropic/claude-sonnet-4` |

LLM API key resolution: `--llm-api-key` > provider-specific env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`/`GEMINI_API_KEY`, `OPENROUTER_API_KEY`) > wizard prompt.

On first gateway deploy (when the gateway worker did not exist before), a gateway auth token is generated automatically if none is provided.

After a successful gateway deploy, the gateway URL and token are saved to local config.

### gsv deploy down

Tear down deployed Cloudflare workers.

```
gsv deploy down [flags]
```

Requires `--all`, at least one `--component`, or `--wizard`. Refuses to run without explicit targets.

| Flag | Type | Env Var | Default | Description |
|------|------|---------|---------|-------------|
| `-c`, `--component` | `string` (repeatable) | | *(none)* | Component to remove. |
| `--all` | `bool` | | `false` | Remove all components. Mutually exclusive with `--component`. |
| `--delete-bucket` | `bool` | | `false` | Also delete the shared R2 storage bucket. |
| `--purge-bucket` | `bool` | | `false` | Purge all objects from the bucket before deleting. Requires `--delete-bucket`. |
| `--wizard` | `bool` | | `false` | Run interactive teardown wizard. |
| `--api-token` | `string` | `CF_API_TOKEN` | Config `cloudflare.api_token` | Cloudflare API token. |
| `--account-id` | `string` | `CF_ACCOUNT_ID` | Config `cloudflare.account_id` | Cloudflare account ID. |

### gsv deploy status

Show deployment status for components.

```
gsv deploy status [flags]
```

| Flag | Type | Env Var | Default | Description |
|------|------|---------|---------|-------------|
| `-c`, `--component` | `string` (repeatable) | | *(all)* | Component to inspect. |
| `--all` | `bool` | | `false` | Inspect all components. Mutually exclusive with `--component`. |
| `--api-token` | `string` | `CF_API_TOKEN` | Config `cloudflare.api_token` | Cloudflare API token. |
| `--account-id` | `string` | `CF_ACCOUNT_ID` | Config `cloudflare.account_id` | Cloudflare account ID. |

---

## gsv session

Manage sessions.

### gsv session list

```
gsv session list [-l LIMIT]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-l`, `--limit` | `integer` | `50` | Maximum number of sessions to return. |

### gsv session get

```
gsv session get [SESSION_KEY]
```

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `session_key` | `string` | `agent:main:cli:dm:main` | Session key to inspect. |

### gsv session stats

```
gsv session stats [SESSION_KEY]
```

Returns message count, token usage (input/output/total), and uptime.

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `session_key` | `string` | `agent:main:cli:dm:main` | Session key. |

### gsv session reset

```
gsv session reset [SESSION_KEY]
```

Clears message history and archives to R2. Creates a new session ID.

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `session_key` | `string` | `agent:main:cli:dm:main` | Session key. |

### gsv session set

```
gsv session set <SESSION_KEY> <PATH> <VALUE>
```

Update session settings.

| Argument | Type | Description |
|----------|------|-------------|
| `session_key` | `string` | Session key. |
| `path` | `string` | Setting path. |
| `value` | `string` | Value to set (parsed as JSON, falls back to string). |

Valid paths:

| Path | Description |
|------|-------------|
| `label` | Session label |
| `model.provider` | LLM provider |
| `model.id` | Model identifier |
| `thinkingLevel` | Thinking level (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`) |
| `systemPrompt` | System prompt override |
| `maxTokens` | Maximum output tokens |
| `resetPolicy.mode` | Reset policy mode (`manual`, `daily`, `idle`) |
| `resetPolicy.atHour` | Hour for daily reset (0-23) |
| `resetPolicy.idleMinutes` | Minutes of idle time before reset |

Paths prefixed with `settings.` are also accepted (e.g., `settings.model.provider`).

### gsv session compact

```
gsv session compact [SESSION_KEY] [-k KEEP]
```

Trim session to the last N messages, archiving removed messages to R2.

| Argument/Flag | Type | Default | Description |
|---------------|------|---------|-------------|
| `session_key` | `string` | `agent:main:cli:dm:main` | Session key. |
| `-k`, `--keep` | `integer` | `20` | Number of messages to keep. |

### gsv session history

```
gsv session history [SESSION_KEY]
```

Show the current session ID and list of previous session IDs (up to 10 shown).

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `session_key` | `string` | `agent:main:cli:dm:main` | Session key. |

### gsv session preview

```
gsv session preview [SESSION_KEY] [-l LIMIT]
```

Preview session messages (user, assistant, toolResult).

| Argument/Flag | Type | Default | Description |
|---------------|------|---------|-------------|
| `session_key` | `string` | `agent:main:cli:dm:main` | Session key. |
| `-l`, `--limit` | `integer` | *(all)* | Number of messages to show. |

---

## gsv tools

Manage tools.

### gsv tools list

```
gsv tools list
```

List all tools available from connected nodes. Sends a `tools.list` RPC request to the gateway.

### gsv tools call

```
gsv tools call <TOOL> [ARGS]
```

Call a tool directly.

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `tool` | `string` | | Tool name (e.g., `macbook:Bash`). |
| `args` | `string` | `{}` | Arguments as a JSON object (e.g., `'{"command": "ls -la"}'`). |

---

## gsv skills

Inspect and refresh skill runtime eligibility.

### gsv skills status

```
gsv skills status [AGENT_ID]
```

Show skill eligibility status for an agent, including connected nodes and their capabilities.

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `agent_id` | `string` | `main` | Agent ID. |

### gsv skills update

```
gsv skills update [AGENT_ID] [--force] [--timeout-ms MS]
```

Re-probe connected nodes for binary availability and show updated skill status.

| Argument/Flag | Type | Default | Description |
|---------------|------|---------|-------------|
| `agent_id` | `string` | `main` | Agent ID. |
| `--force` | `bool` | `false` | Force re-probing even when cache is fresh. |
| `--timeout-ms` | `integer` | *(none)* | Probe timeout in milliseconds. |

---

## gsv heartbeat

Manage heartbeat (proactive agent check-ins).

### gsv heartbeat status

```
gsv heartbeat status
```

Show heartbeat state for all agents, including next/last heartbeat times and delivery channel context.

### gsv heartbeat start

```
gsv heartbeat start
```

Start the heartbeat scheduler.

### gsv heartbeat trigger

```
gsv heartbeat trigger [AGENT_ID]
```

Manually trigger a heartbeat for an agent.

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `agent_id` | `string` | `main` | Agent ID. |

---

## gsv pair

Manage pairing requests (approve/reject new senders from channels).

### gsv pair list

```
gsv pair list
```

List all pending pairing requests with sender name, ID, channel, timestamp, and first message.

### gsv pair approve

```
gsv pair approve <CHANNEL> <SENDER_ID>
```

| Argument | Type | Description |
|----------|------|-------------|
| `channel` | `string` | Channel name (e.g., `whatsapp`). |
| `sender_id` | `string` | Sender ID (e.g., `+1234567890`). |

### gsv pair reject

```
gsv pair reject <CHANNEL> <SENDER_ID>
```

| Argument | Type | Description |
|----------|------|-------------|
| `channel` | `string` | Channel name (e.g., `whatsapp`). |
| `sender_id` | `string` | Sender ID (e.g., `+1234567890`). |

---

## gsv channel

Manage channel accounts.

### gsv channel list

```
gsv channel list
```

List all connected channel accounts with connection time and last message timestamp.

### gsv channel whatsapp login

```
gsv channel whatsapp login [ACCOUNT_ID]
```

Initiate WhatsApp login. Displays a QR code in the terminal for scanning.

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `account_id` | `string` | `default` | Arbitrary name for this WhatsApp account. |

### gsv channel whatsapp status

```
gsv channel whatsapp status [ACCOUNT_ID]
```

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `account_id` | `string` | `default` | Account ID. |

### gsv channel whatsapp logout

```
gsv channel whatsapp logout [ACCOUNT_ID]
```

Logout and clear stored credentials.

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `account_id` | `string` | `default` | Account ID. |

### gsv channel whatsapp stop

```
gsv channel whatsapp stop [ACCOUNT_ID]
```

Stop the WhatsApp connection without clearing credentials.

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `account_id` | `string` | `default` | Account ID. |

### gsv channel discord start

```
gsv channel discord start [ACCOUNT_ID]
```

Start the Discord bot connection. Uses the `DISCORD_BOT_TOKEN` secret configured on the channel worker.

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `account_id` | `string` | `default` | Arbitrary name for this Discord bot. |

### gsv channel discord status

```
gsv channel discord status [ACCOUNT_ID]
```

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `account_id` | `string` | `default` | Account ID. |

### gsv channel discord stop

```
gsv channel discord stop [ACCOUNT_ID]
```

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `account_id` | `string` | `default` | Account ID. |

---

## gsv mount

Mount the R2 bucket to a local directory using rclone.

### gsv mount setup

```
gsv mount setup [--account-id ID] [--access-key-id KEY] [--secret-access-key SECRET] [--bucket NAME]
```

Configure rclone with R2 credentials. Creates an rclone config at `~/.config/gsv/rclone.conf` and the mount point at `~/.gsv/r2/`.

Requires `rclone` to be installed.

| Flag | Type | Env Var | Default | Description |
|------|------|---------|---------|-------------|
| `--account-id` | `string` | `CF_ACCOUNT_ID` | Config `r2.account_id` | Cloudflare Account ID. |
| `--access-key-id` | `string` | `R2_ACCESS_KEY_ID` | Config `r2.access_key_id` | R2 Access Key ID. |
| `--secret-access-key` | `string` | `R2_SECRET_ACCESS_KEY` | Config `r2.secret_access_key` | R2 Secret Access Key. |
| `--bucket` | `string` | | `gsv-storage` (or config `r2.bucket`) | R2 bucket name. |

### gsv mount start

```
gsv mount start [--foreground]
```

Start the rclone FUSE mount. Requires `gsv mount setup` to have been run first.

On macOS, requires macFUSE (`brew install --cask macfuse`) and a non-Homebrew rclone binary. On Linux, requires `fuse3`.

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--foreground` | `bool` | `false` | Run in foreground instead of as a daemon. |

Mount path: `~/.gsv/r2/`

### gsv mount stop

```
gsv mount stop
```

Stop the rclone mount daemon and unmount the filesystem.

### gsv mount status

```
gsv mount status
```

Show whether the mount is running, the mount path, and list agent directories found under the mount.
