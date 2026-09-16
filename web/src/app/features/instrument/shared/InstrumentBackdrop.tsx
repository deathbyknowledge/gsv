import { GlyphStars } from "../../session/backgrounds/GlyphStars";

export function InstrumentBackdrop() {
  return <>
    <div class="instrument-field">
      <GlyphStars density={0.013} />
    </div>
    <div class="instrument-scan" aria-hidden="true" />
    <div class="instrument-vignette" aria-hidden="true" />
  </>;
}
