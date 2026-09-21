import "../styles/gsv-fonts.css";
import "../styles/gsv-tokens.css";
import "../styles/gsv-type.css";
import "../styles.css";
import "../styles/gsv-scrollbar.css";
import { render } from "preact";
import { DesktopApp } from "./DesktopApp";
import { installInputTiming } from "./inputTiming";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Missing #app mount");
installInputTiming();
render(<DesktopApp />, app);
