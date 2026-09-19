# Web search

The model-facing `Search` tool calls the provider-neutral `web.search` syscall to
find indexed web pages. It returns titles, URLs, publication
dates when available, and source excerpts. Excerpts are untrusted web content.
Fetch a selected URL with `net fetch` or CodeMode `fetch` when more detail is needed.

```sh
web search "latest Cloudflare Workers announcements"
web search --include-domain developers.cloudflare.com --limit 5 "Durable Objects RPC"
web search --json "Amsterdam weather"
web search --target personal-search "Amsterdam weather"
```

In CodeMode:

```js
return await web.search({ query: "Cloudflare Workers announcements", limit: 5 });
```

Or select a connected provider:

```js
return await web.search({ target: "personal-search", query: "Cloudflare Workers announcements" });
```

`web.search` requires the `web.search` capability. It accepts `query` (1–2000
characters), `limit` (1–10), and optional `includeDomains` / `excludeDomains`
(up to 10 hostnames each). Its optional `target` defaults to `gsv`, including in
CodeMode blocks with a different default filesystem target. An explicit target
must be accessible, online, and advertise `web.search`; there is no automatic
fallback to another provider. Kernel routing checks target access and applies
the Process's target-scoped approval policy before dispatch. Shell, CodeMode,
and `Search` use the same syscall, validation, cancellation, and result contract.
`targets list` shows implementations and availability. Use Shell commands
(`rg`, `grep`, `find`) for files, or the
target-aware `fs.search` syscall through CodeMode for structured matches.

Operators supply the `gsv` implementation through a `WebSearchService` on the
optional `WEB_SEARCH` binding or `GsvRuntime.services.webSearch`. The Gateway derives the immutable
installation ID; users cannot select an installation or access provider keys.
The service owns provider access, budgets, cancellation and data cleanup.
Routing metadata is removed before calling the provider. Requests time out after
20 seconds. Connected targets can implement the same syscall without a binding
or messaging adapter. `Search` is offered only when the caller has its capability
and either the native service is configured or an accessible online target
advertises search. Calling `gsv` without a binding returns a clear unavailable
error even if another provider is connected. The native `web` command remains
available for explicit target selection.

Each run captures tool-to-syscall routing with its offered schemas. A run already
using the former filesystem `Search` continues using `fs.search` until it finishes.
Stored filesystem search history retains its original syscall and target.
