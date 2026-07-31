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
- Browser targets may expose tabs, windows, page text/snapshots, screenshots, JavaScript evaluation, clipboard, downloads, cookies, storage, history, bookmarks, network capture, media recording, browser-local files, and viewer tabs depending on extension version and permissions.
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
commands --json
tabs --help
page --help
network --help
media --help
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
cat /proc/tabs/<tabId>/resources/index.json
cat /proc/network/status.json
cat /proc/network/events.jsonl
```

Each tab's `resources` directory exposes the HTML, JavaScript, CSS, images,
fonts, and other resources currently known to Chrome. Listing the directory or
reading `index.json` loads only resource metadata. Reading an individual file
loads only that resource body:

```bash
find /proc/tabs/<tabId>/resources -type f
cat /proc/tabs/<tabId>/resources/https/example.com/app~<hash>.js
```

Paths are collision-safe filesystem names; use `index.json` to map them to
their exact URLs, frames, MIME types, and reported sizes. Resource files are
ephemeral views of the live tab. Copy one to `/home/browser` when the task needs
a stable snapshot. For recursive content lookup, use the normal `Search` tool
with the browser target and a path under the tab's `resources` directory; it
uses Chrome's resource search without reading every body. Shell `rg` reads the
files it examines and is better reserved for a small resource directory or a
copied snapshot. A resource body may be unavailable after eviction or
navigation; start browser network capture before reproducing a request when an
exact fetch/XHR response must be retained.

Writable browser-local paths usually include `/tmp`, `/tmp/render`,
`/home/browser`, `/home/browser/screenshots`, `/home/browser/network`, and
`/home/browser/recordings`. Use these for artifacts created by browser
commands, viewer inputs, network captures, screenshots, recordings, and
temporary transfer files.

Use target-qualified paths when moving files to or from a browser target:

```bash
cp macbook:/home/hank/report.pdf [rearden:brave]:/tmp/report.pdf
cp [rearden:brave]:/tmp/report.pdf gsv:/home/hank/report.pdf
```

Target-qualified paths use `target:/absolute/path`. Plain target ids such as
`macbook` do not need brackets. Target ids containing `:` must be bracketed,
such as `[rearden:brave]:/tmp/page.html`.

Run target-qualified `cp` from the native GSV shell or target-aware filesystem
tools. The browser target's just-bash `cp` is local to the browser filesystem.
Use target-aware `cp` for large files. Do not base64 large files through model output.

## Pages and Tabs

Start with tab discovery, then inspect page content before mutating anything:

```bash
tabs list
tabs active
page snapshot --tab <tabId>
page text --tab <tabId>
```

`page snapshot` returns a readable accessibility outline. Actionable elements
and scroll regions carry snapshot-scoped refs such as `@s4k2e7`. The leading
`@` is part of the canonical ref; commands also accept the bare generated form
`s4k2e7`. Refs are pinned to the tab and document that produced them:

```text
textbox @s4k2e1 "Search or start new chat"
scroll-region @s4k2e2 "English Mamá: Hello" [scrollable=y]
  row @s4k2e3 "English"
textbox @s4k2e4 "Type a message" [editable focusable]
```

```bash
page click --tab <tabId> @s4k2e3
page type --tab <tabId> @s4k2e4 'Draft text'
page scroll --tab <tabId> @s4k2e2 down
page scroll --tab <tabId> @s4k2e2 top
```

Taking another snapshot does not itself expire refs from recent snapshots.
Refs expire when their bounded snapshot is evicted, the extension restarts, the
node disappears, its semantics change, or its document navigates. If an action
reports an unknown or stale ref, take a new snapshot instead of guessing which
element replaced it. Prefer the newest refs for virtualized rows because a
framework may reuse a node for different content.

Page actions return compact JSON with separate `delivered` and `observed`
sections. `delivered.accepted` means Chrome accepted the CDP input, and
`delivered.receiver` identifies the hit-tested or focused receiver.
`observed.status` is `changed` or `no-change-detected`; observation covers
navigation, focus, selection, DOM mutations, and target state. Accepted input
with no detected change may be a no-op or an effect outside the observer;
inspect the warning and snapshot again rather than treating it as a transport
failure.

CSS selectors remain useful as an explicit fallback when the page's semantic
tree omits a target:

```bash
page click --tab <tabId> 'button[type=submit]'
page type --tab <tabId> 'input[name=email]' 'hank@example.com'
page key --tab <tabId> Enter
page wait --tab <tabId> '.result' --timeout 10000
page screenshot --tab <tabId>
```

Selector clicks and typing still use Chrome's input pipeline. Use
`page snapshot --dom [selector]` for a bounded raw-DOM debugging view when
semantic names are insufficient. Use a snapshot ref with `page scroll` to
target nested virtualized lists; an untargeted scroll acts at the viewport
center and may be received by whichever scrollable element is under that point.
Targeted `top` and `bottom` repeat native wheel input and report
`observed.scroll.boundaryReached`; check that field instead of assuming an
accepted wheel event reached the boundary. If the target is already there, the
action reports `delivered.skipped=already-at-boundary` with zero events and
does not dispatch input.

Virtualized lists expose only their currently materialized rows. To read one
completely, record the visible semantic rows, scroll the list by its ref,
snapshot again, and deduplicate rows until the reported scroll position stops
changing. Use refs from the newest snapshot for row actions because frameworks
may reuse one DOM node for different rows after scrolling.

`page type` inserts text but does not submit a form or send a message. Treat
Enter, submit buttons, and send controls as separate mutations and invoke them
only when the task authorizes submission.

Use JavaScript evaluation only when page snapshot/text/click/type/wait cannot
express the task:

```bash
page js --tab <tabId> 'document.title'
page js --tab <tabId> 'Array.from(document.querySelectorAll("button")).map((button) => button.textContent)'
```

Prefer semantic refs, then selectors, over coordinates. Always pass `--tab` for
work on an agent-opened tab so a user changing their active tab cannot redirect
selector, key, screenshot, text, wait, or JavaScript commands. Ref actions also
validate that an explicitly supplied tab matches the ref's original tab.

`tabs open` creates a background tab and returns its id. Capture that id and
pass it to every command that operates on the new tab:

```bash
opened="$(tabs open https://example.com)"
tab_id="$(printf '%s\n' "$opened" | tail -n 1 | jq -r '.tab.id')"
page snapshot --tab "$tab_id"
page click --tab "$tab_id" 'a.more-information'
```

Use `tabs open --active` only when the user explicitly asks to see or switch to
new content. For example:

```bash
tabs open --active /home/browser/screenshots/tab-123.png
printf '<h1>Report</h1>' | tabs open --active --mime text/html -
```

For a remote file, first copy it into `/tmp` or `/tmp/render` on the browser
target from the native GSV shell, then run `tabs open` on the browser-local
path. Use `--mime` when stdin or an extensionless file needs an explicit
content type.

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

## Media Recording

Use `media record` to capture tab audio or video into the browser target filesystem:

```bash
media record start --tab <tabId> --path /home/browser/recordings/demo.webm
media record start --tab <tabId> --video --path /home/browser/recordings/demo-video.webm
media record status
media record stop
tabs open /home/browser/recordings/demo.webm
```

Audio recordings are WebM/Opus when supported. Use `--video` or
`--mode video` for tab video with audio; video recordings are WebM when
supported and can grow quickly, so set `--max-bytes` explicitly for longer
captures. Tab capture may require asking the user to focus the tab and click
Grant Recording in the GSV extension UI first; each grant can start one
recording. By default, captured tab audio remains audible; use `--monitor off`
only when the task calls for disabling playback. To move a finished recording
to another target, copy it from the native GSV shell after recording stops.

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
