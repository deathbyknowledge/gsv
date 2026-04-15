import { render } from "preact";
import { getBackend } from "@gsv/package/browser";
import { App } from "./app/app";
import type { FilesBackend } from "./app/types";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Files app root element not found.");
}

const backend = getBackend<FilesBackend>();
render(<App backend={backend} />, root);
