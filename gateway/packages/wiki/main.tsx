import { render } from "preact";
import { getBackend } from "@gsv/package/browser";
import { App } from "./ui/app";
import type { WikiBackend } from "./ui/types";

const root = document.getElementById("app");

if (!root) {
  throw new Error("Wiki app root is missing");
}

void getBackend<WikiBackend>()
  .then((backend) => {
    render(<App backend={backend} />, root);
  })
  .catch((error) => {
    root.innerHTML = `<pre style="padding:16px; color:#b42318; white-space:pre-wrap;">${String(error instanceof Error ? error.message : error)}</pre>`;
  });
