import "../styles/gsv-fonts.css";
import "../styles/gsv-tokens.css";
import "../styles/gsv-type.css";
import "../styles.css";
import "../styles/gsv-scrollbar.css";
import { render } from "preact";
import { DesktopApp } from "./DesktopApp";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Missing #app mount");
render(<DesktopApp />, app);
