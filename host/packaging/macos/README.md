# GSV for macOS

Releases include `gsv-desktop-darwin-arm64.zip` for Apple Silicon and
`gsv-desktop-darwin-x64.zip` for Intel. Unzip and move `GSV.app` to Applications.
The app contains the shared Instrument UI, CLI, machine daemon, voice and gesture
helpers, and third-party notices. macOS 12 or later is required.

These builds are ad-hoc signed, without Developer ID or notarization. After the
first blocked launch, use System Settings → Privacy & Security → Open Anyway.
Microphone and camera access are requested only when enabled. Closing the window
quits the app and stops its helpers; an installed `gsvd` service keeps running.

From the repository root on a Mac, after installing JavaScript dependencies:

```bash
./host/scripts/package-macos.sh --debug
open "host/target/package/macos/$(uname -m)/debug/GSV.app"
```

Use `--release` for optimized binaries or `--skip-build` to assemble existing
binaries. `CARGO_BUILD_TARGET` selects a target-specific Cargo output directory.
The script builds the shared frontend, includes the same-version host executables,
generates the icon, signs the bundle, verifies it, and creates a shareable ZIP.
The release workflow uses this same packaging path.

The speech model downloads on first use with checksum verification. Gesture
models and the CPU inference runtime are embedded in `gsv-vision`.
