import type { RefObject } from "preact";

type LegacyPackageRuntimeAnchorsProps = {
  windowsLayerRef: RefObject<HTMLElement>;
};

export function LegacyPackageRuntimeAnchors({ windowsLayerRef }: LegacyPackageRuntimeAnchorsProps) {
  return (
    <div class="gsv-legacy-runtime" aria-hidden="true">
      <nav class="gsv-legacy-icons" data-desktop-icons aria-label="Legacy package applications" />
      <nav class="gsv-legacy-taskbar" data-taskbar-windows aria-label="Legacy open windows" />
      <section class="windows-layer gsv-legacy-windows" data-windows-layer ref={windowsLayerRef} />
      <section class="mobile-shell gsv-legacy-mobile" data-mobile-shell aria-label="Legacy mobile shell">
        <section data-mobile-home>
          <nav data-mobile-apps aria-label="Legacy mobile applications" />
        </section>
        <button type="button" data-mobile-home-button aria-label="Home" />
      </section>
      <div data-command-palette-root />
    </div>
  );
}
