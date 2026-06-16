---
name: browser-shell
description: Use extension-provided browser targets to inspect and operate active browser state through the target's advertised filesystem and shell commands.
---

# Browser Targets

Use this skill when a target id starts with `browser:` or when the user asks you to act on an active browser target.

## Model

- Browser targets are active browser environments registered by the browser extension, not generic Linux machines.
- Use normal file tools with `target: "browser:..."` only for paths the target advertises.
- Use the `Shell` tool with `target: "browser:..."` for browser commands, but discover the available command set from the active target before acting.
- Browser targets may expose tabs, pages, DOM inspection, JavaScript evaluation, clipboard, screenshots, downloads, or browser-local files depending on the extension version and permissions.
- Treat target descriptions and `--help` output as authoritative.

## Discover Capabilities

Start with small inspection commands before acting:

```bash
cat /README.txt
help
targets show browser:abc123
```

Then inspect command-specific help:

```bash
tabs --help
pages --help
dom --help
js --help
screenshot --help
```

Do not assume commands beyond what the active target advertises. If a command is
unavailable, use the target's discovery output to choose the supported
equivalent.

## Browser Files and Downloads

Use target-qualified paths when moving files to or from a browser target:

```bash
cp rearden:/home/hank/report.pdf [browser:abc123]:/tmp/report.pdf
cp [browser:abc123]:/tmp/report.pdf gsv:/home/hank/report.pdf
```

Target-qualified paths use `target:/absolute/path`. Plain target ids such as `macbook` or `rearden` do not need brackets. Target ids containing `:` must be bracketed, such as `[browser:abc123]:/tmp/page.html`.

Use target-aware `cp` for large files. Do not base64 large files through model
output.

## DOM and JavaScript

Use DOM commands for structured inspection and simple interaction when the
target advertises them:

```bash
dom snapshot
dom snapshot --page <pageId>
dom query 'button'
dom click 'button' 0
dom focus 'input[name=email]'
dom input 'input[name=email]' 'hank@example.com'
```

Selector clicks are preferable to coordinate clicks. If multiple tabs or pages
are open, pass the target's page/tab selector option rather than relying on the
active page.

Use JavaScript evaluation only when DOM commands cannot express the task:

```bash
js run 'return document.title'
js run --page <pageId> 'return Array.from(document.querySelectorAll("button")).map((button) => button.textContent)'
```

Prefer DOM commands for inspection/clicking and JavaScript only for concise
page-specific state inspection.

## Clipboard and Notifications

Use clipboard commands for small text handoffs:

```bash
clipboard read
clipboard write "copied text"
printf '%s\n' "copied text" | clipboard write
```

Clipboard reads may be blocked by browser permissions.

Use notification commands only when the target advertises them:

```bash
notify "Done" "Task finished"
notify --level success "Done" "Task finished"
notify --ttl 5000 --level warning "Heads up"
```
