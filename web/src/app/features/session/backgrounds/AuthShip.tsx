import { useMemo } from "preact/hooks";
import { AsciiAnimation } from "../../../components/ui/AsciiAnimation";
import type { ColorTheme } from "../../../components/ui/useColorTheme";
import { createShipScene } from "./ship/shipScene";
import "./AuthShip.css";

export function AuthShip({ arrival, theme, glyphScale = 1 }: { arrival: boolean; theme: ColorTheme; glyphScale?: 1 | 2 }) {
  const scene = useMemo(() => createShipScene(arrival, glyphScale), [arrival, glyphScale]);
  return <div class="gsv-auth-illustration" data-glyph-scale={glyphScale} aria-hidden="true">
    <AsciiAnimation scene={scene} label="Your Ship" palette={theme} frameRate={18} className="gsv-auth-ship" />
  </div>;
}
