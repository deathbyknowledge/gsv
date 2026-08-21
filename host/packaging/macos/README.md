# macOS development bundle

`package-macos.sh` assembles one self-contained `GSV.app` for technical
dogfooding. The bundle contains Desktop, the CLI, `gsvd`, both local helpers,
the pinned gesture models, a dark rounded-square application icon built from
the canonical white-ship SVG, and the required camera and microphone
permission descriptions.

The packaged application starts gesture recognition automatically; the camera
remains local and gesture control starts disarmed. Voice input is available
from the visible **VOICE** control or `Command+Shift+Space`. Both features ask
for their macOS privacy permission when first used. The same white ship appears
as a monochrome menu-bar item with connection, machine, voice, and gesture
state. Closing the window keeps Desktop available there. **Quit GSV** or
`Command+Q` shuts down Desktop and its voice/gesture helpers without stopping
the independently installed `gsvd` service.

From the repository root on an Apple Silicon or Intel Mac:

```bash
./host/scripts/package-macos.sh --debug
open "host/target/package/macos/$(uname -m)/debug/GSV.app"
```

Use `--release` for optimized binaries. Use `--skip-build` to reassemble an app
from binaries and gesture models already present under `host/target/`.

The output includes `GSV.app` and a matching ZIP. Both are unsigned and
unnotarized development artifacts. macOS may require a control-click followed
by **Open** after the ZIP has been copied to another computer. Move the app to
`/Applications` before connecting the computer so its installed `gsvd`
LaunchAgent keeps a stable executable path. Public distribution still requires
Developer ID signing, hardened-runtime entitlements, Apple notarization, and
stapling.

The bundle layout is:

```text
GSV.app/Contents/
├── Info.plist
├── MacOS/
│   ├── gsv-desktop
│   ├── gsv
│   ├── gsvd
│   ├── gsv-vision
│   ├── gsv-transcribe
│   └── THIRD_PARTY.md
└── Resources/
    ├── GSV.icns
    ├── LICENSE
    └── vision-models/
```

`gsv-transcribe` downloads its checksum-pinned speech model on first use. The
roughly 534 MiB model is deliberately not duplicated inside this application
bundle.
