import { render } from "preact";
import { getBackend } from "@gsv/package/browser";
import { App } from "./app";
import type { ChatBackend } from "./types";

const MARKDOWN_SCRIPTS = [
  {
    id: "chat-dompurify",
    src: "https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.2.7/purify.min.js",
    integrity: "sha512-78KH17QLT5e55GJqP76vutp1D2iAoy06WcYBXB6iBCsmO6wWzx0Qdg8EDpm8mKXv68BcvHOyeeP4wxAL0twJGQ==",
  },
  {
    id: "chat-marked",
    src: "https://cdnjs.cloudflare.com/ajax/libs/marked/16.3.0/lib/marked.umd.min.js",
    integrity: "sha512-V6rGY7jjOEUc7q5Ews8mMlretz1Vn2wLdMW/qgABLWunzsLfluM0FwHuGjGQ1lc8jO5vGpGIGFE+rTzB+63HdA==",
  },
] as const;

const root = document.getElementById("root");

function loadExternalScript(script: (typeof MARKDOWN_SCRIPTS)[number]): Promise<void> {
  const existing = document.querySelector<HTMLScriptElement>(`script[data-gsv-script="${script.id}"]`);
  if (existing) {
    if (existing.dataset.loaded === "true") {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error(`Failed to load ${script.src}`)), { once: true });
    });
  }

  return new Promise((resolve, reject) => {
    const node = document.createElement("script");
    node.src = script.src;
    node.integrity = script.integrity;
    node.crossOrigin = "anonymous";
    node.referrerPolicy = "no-referrer";
    node.dataset.gsvScript = script.id;
    node.addEventListener("load", () => {
      node.dataset.loaded = "true";
      resolve();
    }, { once: true });
    node.addEventListener("error", () => reject(new Error(`Failed to load ${script.src}`)), { once: true });
    document.head.append(node);
  });
}

async function boot(): Promise<void> {
  if (!root) {
    throw new Error("Chat app root element not found.");
  }
  await Promise.all(MARKDOWN_SCRIPTS.map((script) => loadExternalScript(script))).catch((error) => {
    console.warn("[chat] markdown runtime unavailable", error);
  });
  const backend = await getBackend<ChatBackend>();
  render(<App backend={backend} />, root);
}

void boot().catch((error) => {
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
