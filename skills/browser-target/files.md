# Browser Files

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
