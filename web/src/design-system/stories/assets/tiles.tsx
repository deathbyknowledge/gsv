/**
 * Shared tile primitives for the Assets tab stories. Each tile shows the
 * asset, its filename, and a visible UNUSED badge when the manual usage
 * audit found no live app reference for it.
 */

export type AssetEntry = {
  /** Public URL path, e.g. "/icons/chat.svg". */
  path: string;
  /** Display name (filename or icon name). */
  name: string;
  /** Live-app usage flag from the manual grep audit (see story manifests). */
  used: boolean;
};

export function UnusedBadge() {
  return <span class="as-badge">Unused</span>;
}

/** Single-colour SVG rendered as a tinted CSS mask — the same way the app
 *  paints these files (Icon's mask-image). Used → accent tint, unused → dim. */
export function MaskTile({ asset, size = 36 }: { asset: AssetEntry; size?: number }) {
  const mask = `url(${asset.path})`;
  return (
    <div class={asset.used ? "as-tile" : "as-tile is-unused"}>
      <div class="as-frame">
        <span
          class="as-mask"
          role="img"
          aria-label={asset.name}
          style={{
            width: `${size}px`,
            height: `${size}px`,
            WebkitMaskImage: mask,
            maskImage: mask,
          }}
        />
      </div>
      <div class="as-name" title={asset.path}>{asset.name}</div>
      {asset.used ? null : <UnusedBadge />}
    </div>
  );
}

/** Multi-tone or raster asset rendered as a plain image. */
export function ImgTile({ asset, imgSize = 48 }: { asset: AssetEntry; imgSize?: number }) {
  return (
    <div class={asset.used ? "as-tile" : "as-tile is-unused"}>
      <div class="as-frame">
        <img src={asset.path} alt={asset.name} style={{ maxWidth: `${imgSize}px`, maxHeight: `${imgSize}px` }} />
      </div>
      <div class="as-name" title={asset.path}>{asset.name}</div>
      {asset.used ? null : <UnusedBadge />}
    </div>
  );
}
