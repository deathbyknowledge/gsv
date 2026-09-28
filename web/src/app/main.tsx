import "../styles/gsv-fonts.css";
import "../styles/gsv-tokens.css";
// Foundational type utilities — imported at the entry so they load BEFORE any
// component CSS. Components rely on this order: their own class overrides
// (tracking/color/weight) must win over these equal-specificity utilities.
import "../styles/gsv-type.css";
import "../styles.css";
import "../styles/gsv-scrollbar.css";
import { render } from "preact";
import { App } from "./App";
import { DesktopAppLink } from "./features/session/DesktopAppLink";
import { SetupFooterProvider } from "./services/platform/SetupFooter";

const app = document.querySelector<HTMLElement>("#app");

if (!app) {
  throw new Error("Missing #app mount");
}

// Browsers point first-boot setup at the beta Desktop app; Desktop mounts App without this slot.
render(<SetupFooterProvider footer={<DesktopAppLink variant="setup" />}><App /></SetupFooterProvider>, app);
