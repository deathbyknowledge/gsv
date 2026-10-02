# Installer satellite

A satellite study using the UI's mesh renderer: unfolding solar panels, a
raised dish, a gentle turn and an occasional signal pulse. The shell installer
plays cached frames from a checksum-verified release asset while downloading
and installing. It uses the terminal's font and foreground color, so light and
dark terminals both remain readable. The design preview was
reviewed at 10 pt. There is no background layer.

After installing the repository's development dependencies:

```sh
npx esbuild tools/installer-animation/frames.ts --bundle --platform=node --format=esm --outfile=/tmp/gsv-installer-satellite-frames.mjs
node /tmp/gsv-installer-satellite-frames.mjs /tmp/gsv-installer-satellite-frames.json
node tools/installer-animation/play.mjs /tmp/gsv-installer-satellite-frames.json
```

Open the last command in a terminal. R replays the unfolding; Ctrl+C closes
the preview and restores the cursor and previous screen. Its status labels are
simulated; it does not install anything. Three terminal sizes use separate
cached frames. Very small preview terminals show only the current status.

After changing the model, regenerate and commit the release asset:

```sh
node /tmp/gsv-installer-satellite-frames.mjs tools/installer-animation/gsv-installer-animation.gz --release
```

The gzip contains form-feed-separated frames with a `columns rows` header.
Each size has 240 frames at 12 fps; playback loops frames 48–239 after the
initial unfolding. Node is a development tool, not an installer requirement.
Missing or invalid animation assets fall back to the ordinary text installer.
