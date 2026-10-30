import { GlyphStars } from "../../session/backgrounds/GlyphStars";
import { useStarsPreference } from "./useStarsPreference";

/** The instrument's field. Sign-in always has its stars; the signed-in views follow the device preference. */
export function InstrumentBackdrop({ stars }: { stars?: boolean } = {}) {
  const { showStars } = useStarsPreference();
  return <>
    <div class="instrument-field">
      {(stars ?? showStars) && <GlyphStars density={0.013} />}
    </div>
    <div class="instrument-vignette" aria-hidden="true" />
  </>;
}
