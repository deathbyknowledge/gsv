import { useMemo } from "preact/hooks";
import { AsciiAnimation, type AsciiAnimationScene } from "../../../components/ui/AsciiAnimation";
import { AsciiGalaxyScanRenderer, GALAXY_SCAN_FINAL_SECONDS, waitForGalaxyScanFonts } from "../../../components/ui/AsciiGalaxyScan";

/** The wordmark in phosphor, with the auth galaxy's glitch burst every few seconds. */
export function Wordmark() {
  const scene = useMemo<AsciiAnimationScene>(() => {
    const renderer = new AsciiGalaxyScanRenderer({ text: "GSV", cols: 104, rows: 32, particleCount: 3500, frameRate: 15 });
    return {
      stillAt: 0,
      prepare: async () => {
        await waitForGalaxyScanFonts();
        renderer.init();
      },
      frame: (seconds, motion) => renderer.frame(GALAXY_SCAN_FINAL_SECONDS + seconds, motion),
    };
  }, []);
  return <AsciiAnimation inline scene={scene} label="GSV" frameRate={15} fontSize={1.1} className="wordmark" />;
}
