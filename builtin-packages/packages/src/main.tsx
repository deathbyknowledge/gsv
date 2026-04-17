import { render } from "preact";
import { getBackend } from "@gsv/package/browser";
import { App } from "./app/app";
import type { PackagesBackend } from "./app/types";

const root = document.getElementById("root");

async function boot(): Promise<void> {
  if (!root) {
    throw new Error("packages root missing");
  }
  const backend = await getBackend<PackagesBackend>();
  render(<App backend={backend} />, root);
}

void boot().catch((error) => {
  if (!root) {
    throw error;
  }
  render(
    <div class="packages-boot-error">
      <h1>Packages unavailable</h1>
      <p>{error instanceof Error ? error.message : String(error)}</p>
    </div>,
    root,
  );
});
