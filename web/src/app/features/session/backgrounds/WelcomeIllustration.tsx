import { useMemo } from "preact/hooks";
import { AsciiAnimation } from "../../../components/ui/AsciiAnimation";
import { useColorTheme } from "../../../components/ui/useColorTheme";
import { AuthShip } from "./AuthShip";
import { createSpiralScene } from "./spiralScene";
import "./WelcomeIllustration.css";

export function WelcomeIllustration({ kind }: { kind: "create" | "open" }) {
  const { theme } = useColorTheme("dark");
  const spiral = useMemo(createSpiralScene, []);
  if (kind === "open") return <AuthShip theme={theme} compact />;
  return <span class="welcome-illustration" aria-hidden="true">
    <AsciiAnimation scene={spiral} label="A spiral galaxy" frameRate={18} palette={theme} inline className="welcome-illustration-scene" />
  </span>;
}
