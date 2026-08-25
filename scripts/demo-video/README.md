# GSV 1,000-device demo edit

This reproduces the 3:57 caption-led rough cut from the original 23-minute screen recording.
The login is omitted, investigation and remediation beats remain readable, and long fleet
scans are explicitly marked as time-lapses. Source audio is intentionally removed because
the recording contains commercial music and no narration.

Preview render:

```bash
./render.sh
```

Default output: `/home/hank/Videos/gsv-1000-device-demo-rough-v1-preview.mp4`

Final 1440p render:

```bash
MODE=final ./render.sh
```

Default output: `/home/hank/Videos/gsv-1000-device-demo-rough-v1.mp4`

Both commands accept optional input and output paths as their first and second arguments.

## Music version

The licensed music cut uses `The Heist` by Karl Casey at White Bat Audio. Keep
this exact credit in the YouTube description and blog post:

```text
Music: "The Heist" by Karl Casey @ White Bat Audio
```

The artist's license permits use in original video projects with attribution:
<https://whitebataudio.com/license-agreement/>

After downloading the lossless track, add it to the final master with:

```bash
./add-music.sh \
  /home/hank/Videos/gsv-1000-device-demo-rough-v1.mp4 \
  "/home/hank/Downloads/Karl Casey - The Heist.flac" \
  /home/hank/Videos/gsv-1000-device-demo-the-heist-v1.mp4
```

The script copies the already-encoded video, converts the music to 48 kHz AAC,
reduces it by 2 dB, and applies short fades at the opening and close.
