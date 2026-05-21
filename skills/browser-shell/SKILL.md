---
name: browser-shell
description: Use active GSV web shell browser targets to inspect windows/apps, run browser JS, open files, and move files across targets.
---

# Browser Shell Targets

Use this skill when a target id starts with `browser:` or when the user asks you to act on the active GSV web shell desktop.

## Model

- Browser targets are active GSV web shell desktop sessions, not generic Linux machines.
- Use normal file tools with `target: "browser:..."` for browser-local files.
- Use the `Shell` tool with `target: "browser:..."` for desktop/browser commands.
- The browser shell runs just-bash plus GSV commands: `open`, `view`, `cp`, `windows`, `window`, `apps`, `app`, `dom`, and `js`.
- Writable browser-local paths include `/home/browser` and `/tmp`.
- Live metadata is exposed at `/README.txt`, `/desktop/windows.json`, `/desktop/active-window.json`, `/apps.json`, `/apps/<appId>/manifest.json`, and `/windows/<windowId>/meta.json`.

## Discover the Desktop

Start with small inspection commands before acting:

```bash
cat /README.txt
windows list
apps list
cat /desktop/windows.json
cat /apps.json
```

Use window ids from `windows list` for `window`, `dom`, and `js` commands.

## Open Files and Previews

Use `open` for files that should appear in the desktop viewer:

```bash
open --title "Report" /tmp/report.pdf
open --title "Image" rearden:/home/hank/image.png
open --title "Browser file" [browser:abc123]:/tmp/page.html
```

Use `view html` for generated HTML previews:

```bash
printf '%s\n' '<!doctype html><h1>Hello</h1>' | view html --title "Preview"
view html --title "Preview" /tmp/preview.html
```

If `open` or `view` says the viewer app is unavailable, inspect `apps list`. The web shell may need the builtin viewer package synced and the page reloaded.

## Move Files Between Targets

Use target-aware `cp`; do not base64 large files through model output. Browser target ids contain `:`, so bracket them when they appear in shell paths.

```bash
cp rearden:/home/hank/report.pdf [browser:abc123]:/tmp/report.pdf
cp [browser:abc123]:/tmp/report.pdf gsv:/home/hank/report.pdf
cp gsv:/home/hank/report.pdf rearden:/home/hank/report.pdf
```

After copying a file into the browser, open the browser-local copy:

```bash
open --title "Report" /tmp/report.pdf
```

## DOM and JavaScript

Use DOM commands for structured inspection and simple interaction:

```bash
dom snapshot <windowId>
dom query <windowId> 'button'
dom click <windowId> 'button' 0
```

Use `js run` for direct browser-side evaluation in an app window:

```bash
js run <windowId> 'return document.title'
js run --window <windowId> 'return Array.from(document.querySelectorAll("button")).map((button) => button.textContent)'
```

Prefer `dom` for inspection/clicking and `js run` when you need app-specific browser state or a concise script.
