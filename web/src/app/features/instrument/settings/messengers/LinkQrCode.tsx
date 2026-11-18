import type { JSX } from "preact";
import { encode } from "uqr";

/** The blank border scanners need around the code, in modules. */
const QUIET_ZONE = 4;

/**
 * A link drawn as a QR code for a phone camera. It stays dark on light in either theme,
 * because that is what cameras read.
 */
export function LinkQrCode({ url, label }: { url: string; label: string }): JSX.Element {
  const { size, data } = encode(url, { ecc: "M", border: 0 });
  let path = "";
  data.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) path += `M${x} ${y}h1v1h-1z`;
  }));
  const extent = size + QUIET_ZONE * 2;
  return (
    <svg class="gsv-cf-qr" role="img" aria-label={label} viewBox={`${-QUIET_ZONE} ${-QUIET_ZONE} ${extent} ${extent}`}>
      <path d={path} fill="currentColor" />
    </svg>
  );
}
