import { render } from "preact";
import { getBackend } from "@gsv/package/browser";
import { App } from "./app/app";
import type { AdaptersBackend } from "./app/types";

const root = document.getElementById("root");

async function boot(): Promise<void> {
  if (!root) {
    throw new Error("adapters root missing");
  }
  const backend = await getBackend<AdaptersBackend>();
  render(<App backend={backend} />, root);
}

void boot().catch((error) => {
  if (!root) {
    throw error;
  }
  render(
    <div class="adapters-boot-error">
      <h1>Adapters unavailable</h1>
      <p>{error instanceof Error ? error.message : String(error)}</p>
    </div>,
    root,
  );
});
