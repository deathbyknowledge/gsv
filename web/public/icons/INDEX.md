# GSV installation icons

This directory holds application identity assets used by the web manifest,
Apple touch shortcut and Desktop packaging:

- `gsv-192.png` and `gsv-512.png`
- `gsv-maskable-192.png` and `gsv-maskable-512.png`
- `apple-touch-icon.png`

All ship icons come from the approved 4096 × 4096 capture in
[`../brand/gsv-ship.png`](../brand/gsv-ship.png). It uses the actual login
`AuthShip` and `InstrumentBackdrop` components in the dark theme: the original
120 × 60 character grid, Departure Mono at 9px with its normal spacing, reduced
motion's completed frame and one ArrowLeft turn (0.15 radians). Only the framing
centers the hull; the animation's font, geometry and shading are unchanged.
The opaque square also keeps the hull within the maskable icon's
[central 80% circle](https://www.w3.org/TR/appmanifest/#icon-masks), so platforms
can choose their own outline.

Favicon-sized surfaces do not show the ship. The browser tab, the docs site and
the extension toolbar at 16, 24 and 32 carry the Ship's cursor from gsv.space
instead: a flat accent-bright block on the void, aligned left so the lower-right
corner stays free for the tab attention dot. The generator draws that block
from its 32-grid geometry at each size, so no capture is involved.

Regenerate the favicon copies, ICO files, PWA, Apple touch and extension sizes
from that capture with ImageMagick 7 installed:

```sh
node tools/branding/generate-icons.mjs
```

Run this from the repository root. macOS packaging reads the full-resolution
capture directly. The SVG favicon is the cursor on its 32 grid, with no external
font or image dependencies. Icon links use `?v=cursor` to replace cached artwork
from the previous identity; change this version when approving a new capture.

Instrument uses named text controls, quiet borders and typography for its
interface. Its space theme comes from the persistent star field and ASCII art.
The former dot-matrix SVG libraries and mask-based `Icon` component are retired;
they are preserved in Git history and should not be used for new UI.

Follow the [Instrument button policy](../../src/app/features/instrument/README.md#buttons)
and [app surface design guide](../../../engineering/builtin-app-design.md).
Functional graphics such as the live browser cursor are drawn by their owning
component; installation artwork does not define the UI control style.
