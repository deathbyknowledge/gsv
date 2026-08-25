import {
  defineAppManifest,
  defineGsvAppElement,
  type AppElementContext,
  type GsvAppElement,
} from "../index";

export const minimalThreadWindowManifest = defineAppManifest({
  id: "thread-window-example",
  name: "Thread Window Example",
  description: "Minimal thread-aware component app.",
  iconId: "control",
  entrypoint: {
    kind: "component",
    route: "/apps/thread-window-example",
    tagName: "gsv-thread-window-example",
  },
  permissions: [],
  syscalls: [],
  windowDefaults: {
    width: 360,
    height: 220,
    minWidth: 280,
    minHeight: 180,
  },
});

export class GsvThreadWindowExampleElement extends HTMLElement implements GsvAppElement {
  async gsvMount(context: AppElementContext): Promise<void> {
    const thread = context.thread.current();
    const title = document.createElement("h1");
    title.textContent = context.manifest.name;

    const detail = document.createElement("p");
    detail.textContent = thread
      ? `pid=${thread.pid} cwd=${thread.cwd} workspace=${thread.workspace?.rootPath ?? "none"}`
      : "no active thread";

    this.replaceChildren(title, detail);
  }
}

export function ensureMinimalThreadWindowExampleRegistered(): void {
  defineGsvAppElement("gsv-thread-window-example", GsvThreadWindowExampleElement);
}
