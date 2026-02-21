# Security Model

GSV is personal AI infrastructure that can run shell commands on your machines, read and write your files, and communicate on your behalf through messaging platforms. The security stakes are high — a compromised agent could exfiltrate data, execute malicious code, or impersonate you in conversations. This document explains what GSV protects against, how it does so, and — importantly — what it does *not* protect against.

## Trust Boundaries

GSV has several trust boundaries, and understanding them is essential to understanding the security model.

### The Gateway: Trusted Core

The Gateway Worker runs on your Cloudflare account. You deploy it, you configure it, you control its secrets. The Gateway is the most trusted component in the system. It holds:

- API keys for LLM providers (Anthropic, OpenAI, etc.)
- The auth token that gates WebSocket connections
- Channel configurations (bot tokens, allowed senders)
- The agent's workspace files (personality, memory, instructions)

Anyone with access to your Cloudflare account effectively has full access to the Gateway. This is the fundamental trust assumption: your Cloudflare account is secure. If it isn't, everything downstream is compromised.

### Nodes: Trusted but Bounded

Nodes are machines running the Rust CLI in node mode, connected to the Gateway via WebSocket. A node is trusted in the sense that the Gateway will send it tool execution requests and accept the results. But the trust is established through the auth token — any client that presents the correct token during the WebSocket handshake is accepted as a legitimate node.

What can a connected node do? It can:

- Execute any tool call the Gateway sends to it (Bash commands, file operations)
- Report tool results back to the Gateway
- Register its tools in the Gateway's registry

What can't a node do? It cannot:

- Directly access other nodes' tool calls
- Modify the Gateway's configuration
- Send messages as the agent (it can only respond to tool invocations)
- Access R2 storage or the agent's workspace files

The node's security posture depends on the tool implementations in the Rust CLI. The Bash tool, for instance, runs commands in the workspace directory with the permissions of the user who started the node daemon. There's no sandboxing beyond the OS-level user permissions. If you run the node as your user, the agent can do anything your user can do on that machine.

### Channels: Implicitly Trusted

Channel workers connect to the Gateway via Cloudflare Service Bindings. The trust model here is deployment-level: if the Service Binding exists in your Cloudflare configuration, the channel worker can call `GatewayEntrypoint.channelInbound()`. There's no runtime authentication between channels and the Gateway.

This is secure because Service Bindings are configured at deploy time within a single Cloudflare account. A malicious actor would need access to your Cloudflare account to deploy a rogue channel worker — at which point they already have access to everything.

### External Senders: Untrusted Until Paired

People who message your agent through channels (WhatsApp, Discord) are untrusted by default. The pairing system controls who can interact with the agent.

## The Pairing Model

When someone sends a message to your agent's WhatsApp number or Discord bot for the first time, the Gateway checks if the sender is in the `allowFrom` list for that channel. If not, the message is held as a pending pairing request rather than being processed.

You (the operator) can then approve or reject the pairing via the CLI:

```bash
gsv pair list          # See pending requests
gsv pair approve whatsapp +1234567890  # Approve a sender
```

Approval adds the sender's ID to the channel's `allowFrom` list in the Gateway configuration. Future messages from that sender are processed normally.

This is a simple allowlist model. It doesn't use cryptographic verification of sender identity — it trusts the channel's reported sender ID. For WhatsApp, this is a phone number (E.164 format). For Discord, it's a user ID. The security of sender identification depends on the platform's own authentication.

The pairing model is primarily designed for personal use where you know who should have access. It's not designed for public-facing bots where you'd need rate limiting, abuse prevention, and more sophisticated access control.

## Authentication: The Auth Token

The Gateway supports a single shared auth token that gates WebSocket connections. When configured (via `auth.token` in the Gateway config), every connecting client and node must present this token in the `connect` handshake.

The token check uses timing-safe string comparison (`timingSafeEqualStr`) to prevent timing attacks — even though the practical risk of a timing attack over a WebSocket handshake is minimal, it's the right thing to do.

If no auth token is configured, the Gateway accepts any connection. This is the default for local development but should not be used in production.

The auth token is:

- Stored in the Gateway's config (Cloudflare Durable Object storage)
- Stored in the CLI's local config (`~/.config/gsv/config.toml`)
- Transmitted during the WebSocket handshake (over TLS via `wss://`)

There's no token rotation mechanism, no token scoping (all tokens have equal access), and no per-client tokens. A single token authenticates all clients and nodes. If the token is compromised, all connections can be impersonated until the token is changed.

This simplicity is a deliberate choice for personal infrastructure. A multi-user system would need per-user tokens, OAuth flows, and role-based access. GSV assumes a single operator and optimizes for simplicity over sophistication.

## Secret Management

Secrets in GSV live in several places:

### Cloudflare Worker Secrets

LLM API keys and other sensitive configuration can be stored as Worker secrets via `wrangler secret put` or in the Cloudflare dashboard. These are encrypted at rest and available to the Worker as environment variables. The Gateway reads them during initialization and stores them in its config.

### CLI Config File

The CLI stores its configuration at `~/.config/gsv/config.toml`. This includes the Gateway URL, auth token, Cloudflare API token (for deploy commands), and R2 credentials (for the mount command). The file has no special permissions protection — it relies on standard OS file permissions.

### `.dev.vars`

For local development, Worker secrets are stored in `.dev.vars` files (one per Worker directory). These are gitignored and contain environment variables like API keys and tokens. The Gateway, channel workers, and test workers each have their own `.dev.vars`.

### Gateway Config Store

The Gateway's Durable Object config store (accessible via `config.get`/`config.set` RPC) holds runtime configuration including API keys. This is the authoritative runtime source — even if secrets are initially set via Wrangler, the Gateway may store additional keys configured after deployment.

## API Key Flow

LLM provider API keys follow a specific path through the system:

1. Keys are configured in the Gateway's config (via initial setup or `gsv config set apiKeys.anthropic sk-...`).
2. When a Session needs to call the LLM, it requests the full config from the Gateway DO.
3. The Session extracts the API key for the configured provider and passes it to the LLM client library.
4. The API call goes directly from the Cloudflare Worker to the LLM provider's API. Keys never transit through nodes or channels.

This means API keys only exist in two places at runtime: the Gateway's config store and in-memory during LLM calls. They're never sent to nodes, never included in WebSocket frames, and never stored in session history.

## Tool Execution Security

This is perhaps the area that deserves the most honest assessment. GSV's tool execution model is powerful and, by design, permissive.

### What Constraints Exist

- **Workspace scoping**: When a node starts, it's configured with a workspace directory. The file tools (Read, Write, Edit, Glob, Grep) are scoped to this directory — they validate that requested paths fall within the workspace and reject attempts to access files outside it.

- **Tool namespacing**: Nodes can only receive tool calls that match their registered tools. A node that only registered `Read` and `Glob` won't receive `Bash` calls (though in practice, most nodes register all tools).

- **No direct user input execution**: Tool calls come from the LLM, not directly from user input. The user's message is interpreted by the LLM, which generates structured tool calls. The user can't inject arbitrary shell commands — but the LLM can be convinced to run them.

### What Constraints Do Not Exist

- **No sandboxing of Bash**: The `Bash` tool executes commands with the full permissions of the user running the node daemon. There's no container, no seccomp profile, no cgroups isolation. If the node runs as root (don't do this), the agent can do anything.

- **No command filtering**: The Bash tool doesn't filter or blocklist dangerous commands. `rm -rf /`, `curl | sh`, `sudo anything` — if the LLM generates it and the OS user has permission, it executes.

- **No network isolation**: Tools can make arbitrary network requests. The Bash tool can curl external URLs, and there's no egress filtering.

- **No rate limiting on tool execution**: The agent can make as many tool calls as the LLM generates. A runaway loop of tool calls is bounded only by the LLM's behavior and the tool timeout.

The security model for tool execution is essentially: *the agent has the same capabilities as the OS user running the node*. The assumption is that you trust the LLM not to do destructive things unprompted, and you trust yourself not to ask it to do destructive things accidentally.

The system prompt includes a safety section that instructs the agent not to bypass safeguards and to confirm before destructive actions. But this is a soft constraint — it depends on the LLM following instructions, which is not guaranteed against adversarial inputs.

## What the Security Model Does NOT Protect Against

Being honest about limitations is more valuable than overstating protections:

- **Prompt injection via channels**: If an attacker sends carefully crafted messages through WhatsApp or Discord, they might convince the LLM to execute unintended tool calls. The pairing system limits who can message the agent, but approved senders could still attempt prompt injection.

- **Compromised LLM provider**: If the LLM provider's API is compromised or returns malicious responses, those responses could include harmful tool calls that GSV would execute.

- **Token theft**: If the auth token is leaked, an attacker can connect as a client or node. Since there's no per-client identity, there's no way to distinguish a legitimate connection from an illegitimate one with the same token.

- **Workspace escape via symlinks**: While file tools validate that paths are within the workspace, symlinks within the workspace could point outside it. The current implementation doesn't resolve symlinks before path validation.

- **Multi-user isolation**: GSV is designed for single-operator use. If multiple people share an instance, there's no access control between them — anyone with the auth token can read any session, modify any config, or access any workspace file.

- **Side-channel leakage**: The agent's responses might include information from MEMORY.md or workspace files. In sessions with external senders (via channels), the agent might inadvertently share personal information if not carefully instructed.

## Security Recommendations

Given the current model, the practical security posture comes down to:

1. **Always set an auth token** for production deployments. Without it, anyone who discovers the Gateway URL can connect.
2. **Run node daemons as unprivileged users** with minimal necessary permissions. The node inherits its user's filesystem and execution rights.
3. **Be selective with pairing approvals.** Each approved sender can interact with the agent and potentially trigger tool execution.
4. **Scope node workspaces carefully.** Don't point a node at `/` — point it at the specific directory the agent needs access to.
5. **Use MEMORY.md awareness.** If the agent serves external users through channels, be aware that personal memory might influence responses.
6. **Keep the CLI config file secure.** `~/.config/gsv/config.toml` contains your auth token and potentially Cloudflare credentials. Standard file permissions (600) are appropriate.

The security model is honest about being designed for personal use by a trusted operator. It prioritizes capability and simplicity over defense-in-depth. If your threat model includes sophisticated adversaries, additional layers (network isolation, sandboxed execution, audit logging) would be needed on top of what GSV provides.
