import type { JSX } from "preact";
import { useMemo } from "preact/hooks";
import { AsciiAnimation } from "../../../components/ui/AsciiAnimation";
import type { ColorTheme } from "../../../components/ui/useColorTheme";
import { createShipScene, SHIP_GLYPH_SCALE } from "./ship/shipScene";
import "./AuthShip.css";

export function AuthShip({ arrival, theme }: { arrival: boolean; theme: ColorTheme }) {
  const scene = useMemo(() => createShipScene(arrival), [arrival]);
  const style: JSX.CSSProperties & { "--ship-glyph-scale": number } = { "--ship-glyph-scale": SHIP_GLYPH_SCALE };
  return <div class="gsv-auth-illustration" style={style} aria-hidden="true">
    <AsciiAnimation scene={scene} label="Your Ship" palette={theme} frameRate={18} className="gsv-auth-ship" />
  </div>;
}
