import { useMemo } from "preact/hooks";
import { AsciiAnimation } from "../../../components/ui/AsciiAnimation";
import { AsciiGalaxyScan } from "../../../components/ui/AsciiGalaxyScan";
import { useColorTheme } from "../../../components/ui/useColorTheme";
import { createShipScene } from "./ship/shipScene";
import "./WelcomeIllustration.css";

export function WelcomeIllustration({ kind }: { kind: "create" | "open" }) {
  const { theme } = useColorTheme();
  const scene = useMemo(() => kind === "open" ? createShipScene(true) : null, [kind]);
  return <span class="welcome-illustration" aria-hidden="true">
    {scene ? <AsciiAnimation scene={scene} label="Your Ship"
      palette={theme} frameRate={18} inline className="welcome-illustration-scene welcome-illustration-ship" />
      : <AsciiGalaxyScan label="A galaxy forming GSV" cols={144} rows={72} frameRate={18}
        palette={theme} inline showNebula={false} showStars={false} className="welcome-illustration-scene" />}
  </span>;
}
