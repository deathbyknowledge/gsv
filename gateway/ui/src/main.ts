import "./styles.css";
import { mountReactApp } from "./react/bootstrap";

const mount = document.getElementById("app");
if (!mount) {
  throw new Error("Missing #app mount node");
}
mountReactApp(mount);
