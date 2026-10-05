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
simulated; it does not install anything. Playback selects the nearest cached
resolution and scales its character cells to fit the current terminal while
preserving proportions and ANSI styling. Resizing recalculates the dimensions;
the installer caches the scaled frames once per resize. Below 57 columns or
31 rows, only text remains. Growing a small terminal brings the satellite back.

After changing the model, regenerate and commit the release asset:

```sh
node /tmp/gsv-installer-satellite-frames.mjs tools/installer-animation/gsv-installer-animation.gz --release
```

The gzip contains form-feed-separated frames with a `columns rows` header.
The source resolutions are 192×72, 96×36, 76×28 and 56×22 cells; these are
sampling sources, not fixed playback sizes. Each has 240 frames at 12 fps;
playback loops frames 48–239 after the initial unfolding. Node is a development
tool, not an installer requirement.
Missing or invalid animation assets fall back to the ordinary text installer.
