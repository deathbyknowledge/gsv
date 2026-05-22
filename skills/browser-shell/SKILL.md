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
- The browser shell runs just-bash plus GSV commands: `open`, `cp`, `windows`, `window`, `apps`, `app`, `dom`, `js`, `clipboard`, and `notify`.
- Browser shell commands accept `-h` and `--help` for usage.
- Writable browser-local paths include `/home/browser` and `/tmp`.
- Live metadata is exposed under the read-only `/run/gsv` mount, including `/run/gsv/desktop/windows.json`, `/run/gsv/desktop/active-window`, `/run/gsv/apps.json`, `/run/gsv/apps/<appId>/manifest.json`, `/run/gsv/apps/<appId>/windows.json`, `/run/gsv/windows/<windowId>/meta.json`, and `/run/gsv/windows/<windowId>/{app,mode,route,title}.txt`.

## Discover the Desktop

Start with small inspection commands before acting:

```bash
cat /README.txt
windows list
apps list
cat /run/gsv/desktop/windows.json
cat /run/gsv/apps.json
```

`dom` and `js` use the active window by default. Pass `--window <windowId>` when you need a specific window.

## Open Files and Previews

Use `open` for files that should appear in a desktop preview window:

```bash
open /tmp/report.pdf
open macbook:/tmp/hello.txt
open rearden:/home/hank/image.png
open [browser:abc123]:/tmp/page.html
open --title "Report" /tmp/report.pdf
```

Target-qualified paths use `target:/absolute/path`. Plain target ids such as `macbook` or `rearden` do not need brackets. Target ids containing `:` must be bracketed, such as `[browser:abc123]:/tmp/page.html`.

Use `open --as` or stdin for generated previews. Prefer `open` for all previews.

```bash
printf '%s\n' '<!doctype html><h1>Hello</h1>' | open --as html --title "Preview"
open --as html --title "Preview" /tmp/preview.html
```

The preview window is internal to the web shell; it is not a package and does not appear in `apps list`.

## Move Files Between Targets

Use target-aware `cp` when you need a browser-local copy; do not base64 large files through model output. If you only need to inspect a file, `open target:/path` can preview it directly without copying first. Browser target ids contain `:`, so bracket them when they appear in shell paths.

```bash
cp rearden:/home/hank/report.pdf [browser:abc123]:/tmp/report.pdf
cp [browser:abc123]:/tmp/report.pdf gsv:/home/hank/report.pdf
cp gsv:/home/hank/report.pdf rearden:/home/hank/report.pdf
```

After copying a file into the browser, open the browser-local copy:

```bash
open /tmp/report.pdf
```

## DOM and JavaScript

Use DOM commands for structured inspection and simple interaction:

```bash
dom snapshot
dom snapshot --window <windowId>
dom query 'button'
dom click 'button' 0
dom click --xy 120 80
dom focus 'input[name=email]'
dom input 'input[name=email]' 'hank@example.com'
dom input --window <windowId> --selector 'input[name=email]' --text 'hank@example.com' --index 0
```

Selector clicks are the default. Coordinate clicks use document/client coordinates inside the selected window content.

Use `js run` for direct browser-side evaluation in an app window:

```bash
js run 'return document.title'
js run --window <windowId> 'return Array.from(document.querySelectorAll("button")).map((button) => button.textContent)'
```

Prefer `dom` for inspection/clicking and `js run` when you need app-specific browser state or a concise script.

## Clipboard and Notifications

Use clipboard commands for small text handoffs:

```bash
clipboard read
clipboard write "copied text"
printf '%s\n' "copied text" | clipboard write
```

Clipboard reads may be blocked by browser permissions.

Use `notify` to create a GSV desktop notification through the active shell:

```bash
notify "Done" "Task finished"
notify --level success "Done" "Task finished"
notify --ttl 5000 --level warning "Heads up"
```
