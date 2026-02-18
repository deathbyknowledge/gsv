# How to Run a Node

Nodes are machines running the GSV CLI that provide tools to the agent over WebSocket. When a node connects, the agent gains access to Bash, Read, Write, Edit, Glob, and Grep on that machine.

## Install and start a node as a background service

This is the recommended approach. The node runs as a system service (launchd on macOS, systemd on Linux) and reconnects automatically.

```bash
gsv node install --id macbook --workspace ~/projects
```

`--id` sets the node's name (used as a namespace prefix for tools). `--workspace` sets the root directory for file operations.

Check status and logs:

```bash
gsv node status
gsv node logs --follow
```

Stop and start the service:

```bash
gsv node stop
gsv node start
```

## Run a node in the foreground

Useful for debugging or one-off sessions. The node stops when you close the terminal.

```bash
gsv node --foreground --id macbook --workspace ~/projects
```

## Uninstall the node service

```bash
gsv node uninstall
```

This stops the service and removes the service definition. It does not delete the CLI or config.

## How tool namespacing works

Each tool from a node is prefixed with `{nodeId}__`. If a node connects with `--id laptop`, the agent sees:

- `laptop__Bash` -- run shell commands
- `laptop__Read` -- read files
- `laptop__Write` -- write files
- `laptop__Edit` -- edit files (find-and-replace)
- `laptop__Glob` -- find files by pattern
- `laptop__Grep` -- search file contents

The agent uses the prefix to target the correct machine: "I'll check the logs on the server" leads to a `server__Bash` call.

## Connect multiple nodes

You can connect nodes from different machines, each with a different ID and workspace:

```bash
# On your laptop
gsv node install --id laptop --workspace ~/code

# On a server
gsv node install --id server --workspace /var/app
```

The agent sees tools from all connected nodes simultaneously and can reason about which machine to use for a given task.

## Set default node config

To avoid passing `--id` and `--workspace` every time, save defaults to local config:

```bash
gsv local-config set node.id macbook
gsv local-config set node.workspace /Users/me/projects
```

Then you can simply run:

```bash
gsv node install
```

## Node capabilities and skills

Nodes report their OS, available environment variables, and installed binaries to the gateway. Skills (loadable agent capabilities) can declare runtime requirements like specific binaries or OS types. If a skill requires `docker` and no connected node has it, that skill won't appear in the agent's prompt.

To check which skills are eligible given your current nodes:

```bash
gsv skills status
```

To re-probe node capabilities and refresh eligibility:

```bash
gsv skills update --force
```

## Node logs

Node logs are structured JSON at `~/.gsv/logs/node.log` with automatic rotation (default: 10MB, 5 files). Override the limits with environment variables:

```bash
export GSV_NODE_LOG_MAX_BYTES=20000000
export GSV_NODE_LOG_MAX_FILES=3
```

## Verify connected nodes

From any machine with CLI access to the gateway:

```bash
gsv tools list
```

This shows all tools from all connected nodes and native gateway tools.
