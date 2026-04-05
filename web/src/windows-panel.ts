import type { WindowManager, WindowSummary } from "./window-manager";

type WindowsPanelOptions = {
  rootNode: HTMLElement;
  windowManager: WindowManager;
};

type WindowsPanelController = {
  destroy: () => void;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

export function createWindowsPanel(options: WindowsPanelOptions): WindowsPanelController {
  const { rootNode, windowManager } = options;

  const toggleNode = rootNode.querySelector<HTMLButtonElement>("[data-windows-toggle]");
  const panelNode = rootNode.querySelector<HTMLElement>("[data-windows-panel]");
  const listNode = rootNode.querySelector<HTMLElement>("[data-windows-list]");
  const emptyNode = rootNode.querySelector<HTMLElement>("[data-windows-empty]");

  if (!toggleNode || !panelNode || !listNode || !emptyNode) {
    throw new Error("Windows panel markup is incomplete");
  }

  let isOpen = false;

  const setOpen = (open: boolean): void => {
    isOpen = open;
    panelNode.hidden = !open;
    toggleNode.setAttribute("aria-expanded", open ? "true" : "false");
  };

  const render = (summaries: WindowSummary[]): void => {
    const minimized = summaries.filter((summary) => summary.mode === "minimized");

    if (minimized.length === 0) {
      listNode.innerHTML = "";
      listNode.hidden = true;
      emptyNode.hidden = false;
      return;
    }

    const markup = minimized
      .map((summary) => {
        return `<li><button type="button" data-restore-window-id="${summary.windowId}">${escapeHtml(summary.title)}</button></li>`;
      })
      .join("");

    listNode.innerHTML = markup;
    listNode.hidden = false;
    emptyNode.hidden = true;
  };

  const onToggleClick = (): void => {
    setOpen(!isOpen);
  };

  const onDocumentClick = (event: MouseEvent): void => {
    if (!isOpen) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }

    if (panelNode.contains(target) || toggleNode.contains(target)) {
      return;
    }

    setOpen(false);
  };

  const onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !isOpen) {
      return;
    }

    setOpen(false);
  };

  const onListClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const restoreButton = target.closest<HTMLButtonElement>("[data-restore-window-id]");
    if (!restoreButton) {
      return;
    }

    const windowId = restoreButton.dataset.restoreWindowId;
    if (!windowId) {
      return;
    }

    windowManager.restoreWindow(windowId);
    setOpen(false);
  };

  toggleNode.addEventListener("click", onToggleClick);
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onDocumentKeyDown);
  listNode.addEventListener("click", onListClick);

  const unsubscribe = windowManager.subscribe((summaries) => {
    render(summaries);
  });

  setOpen(false);

  return {
    destroy: () => {
      unsubscribe();
      toggleNode.removeEventListener("click", onToggleClick);
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onDocumentKeyDown);
      listNode.removeEventListener("click", onListClick);
    },
  };
}
