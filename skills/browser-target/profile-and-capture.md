# Profile Data, Network Capture, Media Recording and Clipboard

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
captures. Chrome only lets the extension record a tab the person has invoked
it on, so a first `media record start` on a tab may be refused. When it is,
ask the person to focus that tab, open Your Ship from the toolbar, and choose
Allow recording, then run the command again; each allowance starts one
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
