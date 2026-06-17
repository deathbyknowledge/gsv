import { getBackend } from "@humansandmachines/gsv/sdk/browser";
import { FitAddon, init, Terminal } from "ghostty-web";
import { mountShellLayout, setBootState, setStatus, showBootError, type ShellElements } from "./layout";
import { readRouteParams, readWindowId } from "./route-context";
import { createShellTerminalController } from "./terminal-controller";
import { renderTargetOptions, setSelectedTarget } from "./targets";
import type { ShellBackend } from "./types";

let elements: ShellElements | null = null;

async function boot(): Promise<void> {
  elements = mountShellLayout();

  setStatus(elements, "booting", "Loading terminal runtime", "Loading");
  setBootState(elements, "Starting shell", "Loading terminal runtime...");
  await init();

  setBootState(elements, "Connecting shell", "Loading targets and launch context...");
  const windowId = readWindowId();
  const route = readRouteParams(windowId);
  const backend = await getBackend<ShellBackend>();
  const state = await backend.loadState({});
  renderTargetOptions(elements.targetSelect, state.devices, route.target);

  if (route.cwd) {
    elements.cwdInput.value = route.cwd;
  } else if (state.defaultCwd) {
    elements.cwdInput.value = state.defaultCwd;
  }

  if (route.target) {
    setSelectedTarget(elements.targetSelect, route.target);
  }

  setBootState(elements, "Opening terminal", "Preparing the interactive session...");
  createShellTerminalController(elements, { Terminal, FitAddon }, backend);
  setStatus(elements, "ready", "Shell ready");
}

void boot().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  showBootError(elements, message);
});
