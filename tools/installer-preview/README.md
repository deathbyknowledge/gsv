# Installer animation preview

A visual study using the UI's Voyager assembly and idle animation. The labels
simulate installation stages; this demo does not install or change anything.
The production installer is unchanged.

After installing the repository's development dependencies:

```sh
npx esbuild tools/installer-preview/frames.ts --bundle --platform=node --format=esm --outfile=/tmp/gsv-installer-frames.mjs
node /tmp/gsv-installer-frames.mjs /tmp/gsv-installer-frames.json
node tools/installer-preview/play.mjs /tmp/gsv-installer-frames.json
```

Open the last command in a terminal. Ctrl+C closes the preview and restores the
cursor and previous screen. Wide and narrow terminal sizes use separate cached
frames. Very small terminals show only the current status.

Before integration, the actual shell installer should play pre-rendered frames
only on a TTY, drive status from real download/install operations, and stop on
completion or failure. Node is used here for development, not proposed as an
installation prerequisite.
