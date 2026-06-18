---
name: browser-target
description: Use extension-provided browser targets to inspect and operate active browser state through the target's advertised filesystem and shell commands.
aliases: browser-extension, browser
---

# Browser Targets

Use this skill when a target is listed as kind `browser`, has platform
`browser` or `browser-extension`, or when the user asks you to act on an active
browser target. Browser target ids are user-configured and may look like
`browser:chrome`, `rearden:brave`, or another device id.

## Model

- Browser targets are active browser profiles connected by the GSV browser extension.
- Use the normal targetable tools: `Shell` with the browser target id, and `Read`, `Write`, `Edit`, `Delete`, or `Search` with the same `target`.
- Use normal file tools only for paths the target advertises.
- Browser targets may expose tabs, windows, page text/snapshots, screenshots, JavaScript evaluation, clipboard, downloads, cookies, storage, history, bookmarks, network capture, and browser-local files depending on extension version and permissions.
- Treat target descriptions, `/README.txt`, `help`, and `<command> --help` output as authoritative.
- Browser profile commands operate on live user browser state. Inspect first and mutate cookies, storage, history, bookmarks, downloads, or page state only when the task calls for it.

## Discover Capabilities

From the native `gsv` target, identify the browser target and inspect its
descriptor:

```bash
targets list --kind browser
targets show rearden:brave
```

Then run small inspection commands on the browser target itself:

```bash
cat /README.txt
help
tabs --help
page --help
network --help
```

Do not assume commands beyond what the active target advertises. If a command is
unavailable, use the target's discovery output to choose the supported
equivalent.

## Browser Files

Useful read-only runtime paths usually include:

```bash
cat /proc/browser.json
cat /proc/tabs.json
cat /proc/tabs/<tabId>/text.txt
cat /proc/network/status.json
cat /proc/network/events.jsonl
```

Writable browser-local paths usually include `/tmp`, `/home/browser`,
`/home/browser/screenshots`, and `/home/browser/network`. Use these for
artifacts created by browser commands, network captures, screenshots, and
temporary transfer files.

Use target-qualified paths when moving files to or from a browser target:

```bash
cp macbook:/home/hank/report.pdf [rearden:brave]:/tmp/report.pdf
cp [rearden:brave]:/tmp/report.pdf gsv:/home/hank/report.pdf
```

Target-qualified paths use `target:/absolute/path`. Plain target ids such as
`macbook` do not need brackets. Target ids containing `:` must be bracketed,
such as `[rearden:brave]:/tmp/page.html`.

Use target-aware `cp` for large files. Do not base64 large files through model
output.

## Pages and Tabs

Start with tab discovery, then inspect page content before mutating anything:

```bash
tabs list
tabs active
page snapshot --tab <tabId>
page text --tab <tabId>
```

Use selector-based page commands for interaction:

```bash
page click --tab <tabId> 'button[type=submit]'
page type --tab <tabId> 'input[name=email]' 'hank@example.com'
page key --tab <tabId> Enter
page wait --tab <tabId> '.result' --timeout 10000
page screenshot --tab <tabId>
```

Use JavaScript evaluation only when page snapshot/text/click/type/wait cannot
express the task:

```bash
page js --tab <tabId> 'document.title'
page js --tab <tabId> 'Array.from(document.querySelectorAll("button")).map((button) => button.textContent)'
```

Prefer selector clicks to coordinates. If multiple tabs are open, pass `--tab`
rather than relying on the active tab.

## Profile Data

Browser profile commands can inspect or mutate real profile state:

```bash
cookies list example.com
storage local get
history search --limit 20 query
bookmarks search query
```

Mutation examples:

```bash
cookies set https://example.com name value
history delete https://example.com/
bookmarks create <parentId> https://example.com "Example"
```

For browser downloads, use the browser target's `downloads` command. Browser
downloads are real browser-profile downloads, while `/tmp` and `/home/browser`
are the target filesystem exposed through GSV.

```bash
downloads list --limit 20
downloads start https://example.com/file.pdf --filename file.pdf
downloads get <downloadId>
```

## Network Capture

```bash
network start --tab <tabId> --bodies --persist
network status --tab <tabId>
network events --tab <tabId> --limit 50
network get <requestId> --body
network export har --tab <tabId> --path /home/browser/network/capture.har
network stop --tab <tabId>
```

Use `--persist` when the capture should create files under
`/home/browser/network/sessions/...`. Without persistence, inspect through the
network command output or the `/proc/network/*` runtime files.

## Clipboard

Use clipboard commands for small text handoffs:

```bash
clipboard read
clipboard write "copied text"
printf '%s\n' "copied text" | clipboard write
```

Clipboard access may be unavailable in MV3 service-worker contexts until an
offscreen document bridge is enabled. Treat command errors as capability
signals, not as proof that the browser target is disconnected.
