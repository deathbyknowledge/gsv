import { useMemo } from "preact/hooks";
import { AsciiAnimation } from "../../../components/ui/AsciiAnimation";
import { useColorTheme } from "../../../components/ui/useColorTheme";
import { AuthShip } from "./AuthShip";
import { createSpiralScene } from "./spiralScene";
import { useT } from "../../../i18n/locale";
import "./WelcomeIllustration.css";

export function WelcomeIllustration({ kind }: { kind: "create" | "open" }) {
  const t = useT();
  const { theme } = useColorTheme("dark");
  const spiral = useMemo(createSpiralScene, []);
  if (kind === "open") return <AuthShip theme={theme} compact />;
  return <span class="welcome-illustration" aria-hidden="true">
    <AsciiAnimation scene={spiral} label={t("session.scene.galaxy")} frameRate={18} palette={theme} inline className="welcome-illustration-scene" />
  </span>;
}
