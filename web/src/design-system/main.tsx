import "../styles/gsv-fonts.css";
import "../styles/gsv-tokens.css";
import "./catalog.css";
import { render } from "preact";
import { Catalog } from "./catalog";

const mount = document.querySelector<HTMLElement>("#design-system");
if (!mount) {
  throw new Error("Missing #design-system mount");
}

render(<Catalog />, mount);
