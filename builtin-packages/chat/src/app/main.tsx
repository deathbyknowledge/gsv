import { render } from "preact";
import { getBackend, setAppError } from "@gsv/package/browser";
import { App } from "./app";
import type { ChatBackend } from "./types";

const root = document.getElementById("root");

async function boot(): Promise<void> {
  if (!root) {
    throw new Error("Chat app root element not found.");
  }
  const backend = await getBackend<ChatBackend>();
  render(<App backend={backend} />, root);
}

void boot().catch((error) => {
  setAppError(error);
  if (!root) {
    throw error;
  }
  render(
    <div class="chat-boot-error">
      <h1>Chat unavailable</h1>
      <p>{error instanceof Error ? error.message : String(error)}</p>
    </div>,
    root,
  );
});
