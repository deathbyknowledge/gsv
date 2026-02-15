---
name: gsv-cli
description: GSV command-line interface for managing the agent, sessions, config, and workspace
always: false
---

# GSV CLI

The `gsv` command-line tool manages your GSV agent deployment.

## Installation

```bash
cd ~/c2/gsv/cli
cargo build --release
# Binary at: ~/c2/gsv/cli/target/release/gsv
```

## Configuration

### Initial Setup

```bash
gsv init  # Creates config file with prompts for gateway URL and token
```

Config file location: `~/.config/gsv/config.toml` (Linux) or `~/Library/Application Support/gsv/config.toml` (macOS)

### Local Config Commands

```bash
gsv local-config show                           # Show full config
gsv local-config get gateway.url                # Get specific value
gsv local-config set gateway.url wss://...      # Set value
gsv local-config set gateway.token <token>      # Set auth token
```

## Gateway Config

These commands modify the remote gateway configuration:

```bash
gsv config get                                  # Show all config
gsv config set model.id claude-sonnet-4-20250514
gsv config set apiKeys.anthropic sk-...
gsv config set channels.whatsapp.dmPolicy allowlist
gsv config set channels.whatsapp.allowFrom '["+1234567890"]'
gsv config set transcription.provider openai    # or workers-ai (default)
```

## Session Management

```bash
gsv session list                    # List all sessions
gsv session stats <key>             # Show session statistics
gsv session get <key>               # Get full session state
gsv session history <key>           # Show message history
gsv session preview <key>           # Preview last few messages
gsv session reset <key>             # Reset/clear session
gsv session compact <key> [N]       # Compact to last N messages
```

Session keys follow the format: `agent:{agentId}:{channel}:{peerKind}:{peerId}`
Examples:
- `main` - CLI main session
- `agent:main:whatsapp:dm:1234567890@s.whatsapp.net` - WhatsApp DM

## Chat (Client Mode)

Send messages directly to the agent:

```bash
gsv client "Hello, how are you?"
gsv client "What's the weather?" --session weather-check
gsv client "Remember this" --session main
```

## Heartbeat

The heartbeat system sends periodic check-ins to the agent:

```bash
gsv heartbeat status                # Show heartbeat state and delivery target
gsv heartbeat start                 # Start the heartbeat scheduler
gsv heartbeat trigger <agent>       # Manually trigger heartbeat (default: main)
```

## Skills

Inspect and refresh runtime skill eligibility:

```bash
gsv skills status [agent-id]                         # Show eligibility snapshot
gsv skills update [agent-id]                         # Refresh node bin checks + show status
gsv skills update [agent-id] --force --timeout-ms 20000
```

## R2 Workspace Mount

Mount your R2 workspace locally via rclone FUSE:

### Prerequisites
1. Install macFUSE: `brew install --cask macfuse`
2. Enable kernel extensions (Recovery Mode)
3. Install rclone from https://rclone.org/downloads/

### Commands

```bash
gsv mount setup                     # Configure R2 credentials
gsv mount start                     # Start the mount
gsv mount stop                      # Stop the mount
gsv mount status                    # Check mount status
```

After mounting:
- Full bucket: `/Volumes/gsv-storage/`
- Agent workspace: `~/gsv/` (symlink to `agents/main/`)

### R2 Credentials

Set in local config or pass to setup:
```bash
gsv local-config set r2.account_id <cloudflare-account-id>
gsv local-config set r2.access_key_id <r2-access-key>
gsv local-config set r2.secret_access_key <r2-secret>
```

## Channel Management

```bash
gsv channel whatsapp login [account-id]   # Login with QR code
gsv channel whatsapp status [account-id]  # Check connection status
gsv channel whatsapp logout [account-id]  # Clear credentials
gsv channel whatsapp stop [account-id]    # Stop connection
```

## Tools

When running as a node, the CLI provides these tools to the agent:

```bash
gsv node --id my-node               # Start as tool-providing node
```

Available tools:
- `Bash` - Execute shell commands
- `Read` - Read file contents
- `Write` - Write file contents
- `Edit` - Edit files (find/replace)
- `Glob` - Find files by pattern
- `Grep` - Search file contents

## Common Workflows

### Check WhatsApp Status
```bash
gsv channel whatsapp status
gsv heartbeat status   # Shows delivery target if WhatsApp active
gsv session list       # Find WhatsApp sessions
```

### Reset a Stuck Session
```bash
gsv session reset agent:main:whatsapp:dm:123@s.whatsapp.net
```

### Update Model
```bash
gsv config set model.id claude-sonnet-4-20250514
gsv config set model.provider anthropic
```

### Add Phone to Allowlist
```bash
gsv config set channels.whatsapp.allowFrom '["+1234567890", "+0987654321"]'
```

## Troubleshooting

### Connection Issues
```bash
gsv local-config show   # Verify gateway URL and token
```

### Mount Not Working
```bash
gsv mount status        # Check if mounted
gsv mount stop && gsv mount start   # Restart mount
```

### Session Not Responding
```bash
gsv session stats <key>   # Check message count, last activity
gsv session reset <key>   # Reset if stuck
```
