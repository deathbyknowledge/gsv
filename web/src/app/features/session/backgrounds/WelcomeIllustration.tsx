import { AsciiGalaxyScan } from "../../../components/ui/AsciiGalaxyScan";
import { useColorTheme } from "../../../components/ui/useColorTheme";
import { AuthShip } from "./AuthShip";
import "./WelcomeIllustration.css";

export function WelcomeIllustration({ kind }: { kind: "create" | "open" }) {
  const { theme } = useColorTheme();
  if (kind === "open") return <AuthShip theme={theme} compact />;
  return <span class="welcome-illustration" aria-hidden="true">
    <AsciiGalaxyScan label="A galaxy forming GSV" cols={144} rows={72} frameRate={18}
      palette={theme} inline showNebula={false} showStars={false} className="welcome-illustration-scene" />
  </span>;
}
