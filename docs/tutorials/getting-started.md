# Getting Started with GSV

In this tutorial, we will deploy a GSV agent to Cloudflare, send it a message from the command line, and then connect a node so the agent can run commands on your machine. By the end, you will have a working AI agent you can chat with that has access to tools on your computer.

## Prerequisites

Before we begin, make sure you have:

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (the free tier works)
- A [Cloudflare API token](https://dash.cloudflare.com/profile/api-tokens) with the **Edit Cloudflare Workers** template
- An API key from an LLM provider (Anthropic, OpenAI, Google, or OpenRouter)

## 1. Install the CLI

Run the install script to download the `gsv` binary:

```bash
curl -sSL https://install.gsv.space | bash
```

Verify the installation:

```bash
gsv --version
```

You should see output like `gsv 0.x.x`.

## 2. Deploy the gateway

The gateway is the central worker that runs your agent on Cloudflare's edge network. We will use the deploy wizard, which walks you through the setup interactively.

Run:

```bash
gsv deploy up --wizard
```

The wizard will prompt you for several things. Here is what to expect:

1. **Cloudflare API token** -- paste the token you created in the prerequisites.
2. **Cloudflare account** -- if your token has access to multiple accounts, select the one you want to use.
3. **Components** -- select `gateway` for now. We will add channels later.
4. **Security notice** -- confirm that you understand the agent can execute commands.
5. **LLM provider** -- select your provider (e.g., `anthropic`).
6. **LLM model** -- accept the default or type a specific model ID.
7. **LLM API key** -- paste your provider API key.
8. **Deployment summary** -- review and confirm.

The wizard downloads prebuilt bundles from GitHub, creates an R2 storage bucket, and deploys the gateway worker. This takes about a minute.

When it finishes, you will see output that includes your gateway URL, something like:

```
Gateway URL: https://gsv.your-subdomain.workers.dev
```

The wizard automatically saves the gateway URL and auth token to your local config at `~/.config/gsv/config.toml`. You can verify this:

```bash
gsv local-config show
```

Notice the `[gateway]` section now has `url` and `token` values filled in.

## 3. Send your first message

Now that the gateway is deployed, we can chat with the agent using the CLI client:

```bash
gsv client "Hello, what can you help me with?"
```

You should see the agent respond. The first message triggers the agent's commissioning ceremony -- it will introduce itself and may ask about your name and preferences. This is normal; the agent is setting up its identity through its workspace files.

To enter an interactive chat session (where you can send multiple messages), run `gsv client` without a message argument:

```bash
gsv client
```

Type messages and press Enter to send. Press `Ctrl+C` to exit.

At this point, the agent can chat but has no tools -- it cannot run commands or access files on your machine. Let's fix that.

## 4. Connect a node

A node is a CLI instance running on your machine that provides tools (Bash, Read, Write, Edit, Glob, Grep) to the agent. When a node is connected, the agent can execute shell commands, read and write files, and search your codebase.

Start a node in the foreground:

```bash
gsv node --foreground --id mynode --workspace ~/projects
```

- `--id mynode` sets the node's name. The agent sees tools prefixed with this name (e.g., `mynode__Bash`, `mynode__Read`).
- `--workspace ~/projects` sets the root directory the node's file tools operate in.

You should see output indicating the node connected to the gateway:

```
Connected to gateway as node "mynode"
Registered tools: Bash, Read, Write, Edit, Glob, Grep
```

Leave this terminal running. The node needs to stay connected for the agent to use its tools.

## 5. Verify the agent can use tools

Open a second terminal and ask the agent to do something that requires tools:

```bash
gsv client "List the files in my workspace"
```

The agent will use the `mynode__Glob` or `mynode__Bash` tool to list files and return the results. You should see it reference the files in `~/projects`.

Try another command:

```bash
gsv client "What operating system am I running? Use bash to find out."
```

The agent will call `mynode__Bash` with a command like `uname -a` and report back.

Notice in the first terminal (where the node is running) that you can see the tool invocations being processed.

## 6. Install the node as a service (optional)

Running the node in the foreground is useful for debugging, but for day-to-day use you will want it running as a background service. Stop the foreground node with `Ctrl+C`, then install it:

```bash
gsv node install --id mynode --workspace ~/projects
```

This installs and starts the node as a system service (launchd on macOS, systemd on Linux). Check its status:

```bash
gsv node status
```

View the logs:

```bash
gsv node logs --follow
```

The node will automatically reconnect to the gateway if the connection drops.

## What we accomplished

You now have a working GSV deployment:

- A **gateway** worker running on Cloudflare that hosts your AI agent
- A **CLI client** for chatting with the agent
- A **node** on your machine giving the agent access to shell commands and file operations

From here, you can:

- [Connect a messaging channel](setting-up-a-channel.md) (WhatsApp or Discord) so you can talk to your agent from your phone
- [Write a custom skill](writing-a-skill.md) to teach the agent new capabilities
- Customize the agent's personality by editing its workspace files (`gsv config get` to see current config, or mount the R2 workspace with `gsv mount`)
