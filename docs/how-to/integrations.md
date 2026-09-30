# Integrations (MCP)

Integrations give GSV new tools through [MCP](https://modelcontextprotocol.io) servers — calendars, search, your own internal services, anything that speaks MCP. Once a server is connected, your agents discover its tools with `mcp list` and `mcp search`, and call them directly or from CodeMode.

## Add an MCP server

1. Open **Settings → mcp** and click **add MCP server.**
2. Give it a **Name** and paste its **Server URL**. Leave **Transport** on **automatic** unless the server needs **streamable HTTP** or **server-sent events** specifically.
3. If the server needs an API key or another HTTP header, open **Custom headers** and add the header name and value.
4. Click **add server.**

Servers that use OAuth show a **sign in** link on their row after they are added; follow it to authorise GSV. Each row lists the server's tool, resource and prompt counts. **refresh** re-reads its catalogue and **remove** disconnects it. Servers added by another account appear as **read only**.

Adding a server requires the `sys.mcp.add` capability; calling a tool through it asks for approval by default (see the [approval policy](/reference/configuration#tool-approval-policy)).

## From a shell

```bash
mcp list
mcp search "what you need"
mcp describe <server> <tool>
mcp call <server> <tool> --args-json '<arguments>' --json
```

## See also

- [Get Started](/get-started/)
- [Configuration reference](/reference/configuration)
