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
  const originalParent = panelNode.parentElement;
  const originalNextSibling = panelNode.nextSibling;
  const resizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => {
        positionPanel();
      })
    : null;

  document.body.appendChild(panelNode);

  const positionPanel = (): void => {
    if (!isOpen) {
      return;
    }
    const rect = toggleNode.getBoundingClientRect();
    const width = panelNode.offsetWidth || 240;
    const height = panelNode.offsetHeight || 120;
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const left = Math.min(maxLeft, Math.max(8, rect.left + rect.width / 2 - width / 2));
    const top = rect.top - height - 10 >= 8 ? rect.top - height - 10 : rect.bottom + 10;
    panelNode.style.left = `${left}px`;
    panelNode.style.top = `${top}px`;
  };

  const setOpen = (open: boolean): void => {
    isOpen = open;
    panelNode.hidden = !open;
    toggleNode.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      panelNode.style.position = "fixed";
      panelNode.style.bottom = "auto";
      panelNode.style.right = "auto";
      panelNode.style.transform = "none";
      panelNode.style.zIndex = "260";
      panelNode.style.visibility = "hidden";
      requestAnimationFrame(() => {
        positionPanel();
        panelNode.style.visibility = "visible";
        console.debug("[windows-panel] set open", {
          hidden: panelNode.hidden,
          rect: panelNode.getBoundingClientRect().toJSON?.() ?? null,
        });
      });
    } else {
      panelNode.style.visibility = "";
      console.debug("[windows-panel] set closed", { hidden: panelNode.hidden });
    }
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

    if (isOpen) {
      requestAnimationFrame(() => {
        positionPanel();
      });
    }
  };

  const onToggleClick = (): void => {
    console.debug("[windows-panel] toggle click", { isOpen, hidden: panelNode.hidden });
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
    console.debug("[windows-panel] list click", {
      target: event.target instanceof HTMLElement ? event.target.outerHTML.slice(0, 120) : String(event.target),
    });
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
    console.debug("[windows-panel] restore window", { windowId });
    setOpen(false);
  };

  toggleNode.addEventListener("click", onToggleClick);
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onDocumentKeyDown);
  window.addEventListener("resize", positionPanel);
  listNode.addEventListener("click", onListClick);
  resizeObserver?.observe(panelNode);

  const unsubscribe = windowManager.subscribe((summaries) => {
    render(summaries);
  });

  setOpen(false);

  return {
    destroy: () => {
      unsubscribe();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", positionPanel);
      toggleNode.removeEventListener("click", onToggleClick);
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onDocumentKeyDown);
      listNode.removeEventListener("click", onListClick);
      if (originalParent) {
        if (originalNextSibling) {
          originalParent.insertBefore(panelNode, originalNextSibling);
        } else {
          originalParent.appendChild(panelNode);
        }
      } else {
        panelNode.remove();
      }
    },
  };
}
