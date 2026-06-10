# MCP Servers & OAuth Accounts

[Integrations](index.md)

## MCP Servers

MCP servers add external tools and resources to GSV. They may expose file systems, issue trackers, databases, search tools, design tools, or other capabilities.

Use MCP settings to:

- Add a server.
- Check connection status.
- Refresh available tools.
- Remove a server.
- Troubleshoot unavailable tools.

MCP tools may appear in agent or coding environments rather than as ordinary desktop apps. Availability can depend on the current account, server health, and tool permissions.

## OAuth Accounts

OAuth accounts connect GSV to external services using the user's consent. Use OAuth for services that support delegated access, such as code hosting, productivity tools, or cloud APIs.

Use OAuth settings to:

- Start an authorization flow.
- Review connected accounts.
- Revoke an account.
- Repair an expired connection.

OAuth tokens are sensitive and should not be displayed in chat or stored in ordinary files.

## Choosing Between MCP And OAuth

MCP describes how tools are exposed to GSV. OAuth describes how GSV gets permission to access an external account. A single integration may use both: OAuth for authorization and MCP for tool access.

## For Agents

If an external tool is missing, check whether the account is connected, the server is healthy, and the tool is available to the current identity. Do not ask the user to paste OAuth tokens into chat.
