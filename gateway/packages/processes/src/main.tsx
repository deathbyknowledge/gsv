import { render } from "preact";
import { getBackend } from "@gsv/package/browser";
import { App } from "./app/app";
import type { ProcessesBackend } from "./app/types";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Processes app root element not found.");
}

void getBackend<ProcessesBackend>()
  .then((backend) => {
    render(<App backend={backend} />, root);
  })
  .catch((error) => {
    root.innerHTML = `<pre style="padding:16px; color:#b42318; white-space:pre-wrap;">${String(error instanceof Error ? error.message : error)}</pre>`;
  });
