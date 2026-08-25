# GSV browser-extension demo edit

This reproduces the silent, caption-led public cut of the Instagram/browser-extension
recording. It keeps the prompt, browser-target discovery, the switch from the
algorithmic feed to `Following`, the story/notification checks, and the final
catch-up. Repetitive extraction work is accelerated.

The source recording is never modified. The real final answer remains visible
for the payoff. Only account-specific story, notification, follow-request,
security-alert, and mutual-connection details are replaced with faithful
generic lines; public post handles and summaries remain visible.

Preview render:

```bash
./render.sh
```

Final 1440p render:

```bash
MODE=final ./render.sh
```

No source audio is retained. The optional music pass uses the separately
downloaded `The Son of Flynn.mp3` without burning any credit into the picture:

```bash
./add-son-of-flynn.sh \
  /home/hank/Videos/gsv-instagram-browser-demo-report-v2.mp4 \
  "/home/hank/Downloads/The Son of Flynn.mp3" \
  /home/hank/Videos/gsv-instagram-browser-demo-son-of-flynn-v2.mp4
```
