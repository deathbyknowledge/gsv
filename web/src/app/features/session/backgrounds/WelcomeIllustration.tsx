import { useMemo } from "preact/hooks";
import { AsciiAnimation } from "../../../components/ui/AsciiAnimation";
import { useColorTheme } from "../../../components/ui/useColorTheme";
import { createWelcomeScene, type WelcomeIllustrationKind } from "./welcomeScene";
import "./WelcomeIllustration.css";

export function WelcomeIllustration({ kind }: { kind: WelcomeIllustrationKind }) {
  const { theme } = useColorTheme();
  const scene = useMemo(() => createWelcomeScene(kind), [kind]);
  return <span class="welcome-illustration" aria-hidden="true">
    <AsciiAnimation scene={scene} label={kind === "create" ? "A world taking shape" : "An opening gateway"}
      palette={theme} frameRate={18} inline className="welcome-illustration-scene" />
  </span>;
}
