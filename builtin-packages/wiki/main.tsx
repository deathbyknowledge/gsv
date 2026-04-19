import { render } from "preact";
import { getBackend } from "@gsv/package/browser";
import { App } from "./src/app/app";
import type { WikiBackend } from "./src/app/types";

const root = document.getElementById("root");

async function boot(): Promise<void> {
  if (!root) {
    throw new Error("wiki root missing");
  }
  const backend = await getBackend<WikiBackend>();
  render(<App backend={backend} />, root);
}

void boot().catch((error) => {
  if (!root) {
    throw error;
  }
  render(
    <div class="wiki-boot-error">
      <h1>Wiki unavailable</h1>
      <p>{error instanceof Error ? error.message : String(error)}</p>
    </div>,
    root,
  );
});
