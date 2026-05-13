import { render } from "preact";
import { App } from "./app/App";

const root = document.getElementById("root");
if (!root) {
  throw new Error("GSV app root element not found.");
}

render(<App />, root);
