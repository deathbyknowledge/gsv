import { GlyphStars } from "../../session/backgrounds/GlyphStars";
import { useStarsPreference } from "./useStarsPreference";

export function InstrumentBackdrop() {
  const { showStars } = useStarsPreference();
  return <>
    <div class="instrument-field">
      {showStars && <GlyphStars density={0.013} />}
    </div>
    <div class="instrument-vignette" aria-hidden="true" />
  </>;
}
