# GSV installation icons

This directory holds application identity assets used by the web manifest,
Apple touch shortcut and Desktop packaging:

- `gsv-192.png` and `gsv-512.png`
- `gsv-maskable-192.png` and `gsv-maskable-512.png`
- `apple-touch-icon.png`

Instrument uses named text controls, quiet borders and typography for its
interface. Its space theme comes from the persistent star field and ASCII art.
The former dot-matrix SVG libraries and mask-based `Icon` component are retired;
they are preserved in Git history and should not be used for new UI.

Follow the [Instrument button policy](../../src/app/features/instrument/README.md#buttons)
and [app surface design guide](../../../engineering/builtin-app-design.md).
Functional graphics such as the live browser cursor are drawn by their owning
component; installation artwork does not define the UI control style.
