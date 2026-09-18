# Web search

The model-facing `Search` tool uses the installation's configured search service to find indexed
web pages without a connected browser. It returns titles, URLs, publication
dates when available, and source excerpts. Excerpts are untrusted web content.
Fetch a selected URL with `net fetch` or CodeMode `fetch` when more detail is needed.

```sh
web search "latest Cloudflare Workers announcements"
web search --include-domain developers.cloudflare.com --limit 5 "Durable Objects RPC"
web search --json "Amsterdam weather"
```

In CodeMode:

```js
return await web.search({ query: "Cloudflare Workers announcements", limit: 5 });
```

`web.search` requires the `web.search` capability. It accepts `query` (1–2000
characters), `limit` (1–10), and optional `includeDomains` / `excludeDomains`
(up to 10 hostnames each). It is a service syscall, not target-routed. Shell and
CodeMode and the `Search` tool use that same boundary. `Search` has no `target`
or filesystem mode. Use Shell commands (`rg`, `grep`, `find`) for files, or the
target-aware `fs.search` syscall through CodeMode for structured matches.

Operators supply a `WebSearchService` through the optional `WEB_SEARCH` binding
or `GsvRuntime.services.webSearch`. The Gateway derives the immutable
installation ID; users cannot select an installation or access provider keys.
The service owns provider access, budgets, cancellation and data cleanup.
Requests time out after 20 seconds. Installations without a binding do not
advertise `Search` or the `web` shell command; direct syscall calls receive a
clear unavailable error.

Each run captures tool-to-syscall routing with its offered schemas. A run already
using the former filesystem `Search` continues using `fs.search` until it finishes.
Stored filesystem search history retains its original syscall and target.
