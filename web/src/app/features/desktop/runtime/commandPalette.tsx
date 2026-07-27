import { render as renderPreact } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { DesktopAppIconGlyph } from "../components/DesktopLauncherViews";
import type { DesktopAppIcon } from "../domain/desktopApp";
import { filterLauncherPaletteItems } from "../domain/launcherState";

export type CommandPaletteActionItem = {
  id: string;
  label: string;
  meta: string;
  search: string;
  icon: DesktopAppIcon;
  run: () => void;
};

export type CommandPaletteController = {
  open: () => void;
  close: () => void;
  toggle: () => void;
  refresh: () => void;
  isOpen: () => boolean;
  destroy: () => void;
};

type CommandPaletteOptions = {
  rootNode: HTMLElement;
  getItems: () => readonly CommandPaletteActionItem[];
  onOpen: () => void;
  onClose: () => void;
};

type CommandPaletteSnapshot = {
  open: boolean;
  query: string;
  selectedIndex: number;
  items: readonly CommandPaletteActionItem[];
  focusToken: number;
};

type CommandPaletteViewActions = {
  close: () => void;
  setQuery: (query: string) => void;
  moveSelection: (delta: number) => void;
  runSelected: () => void;
  runAt: (index: number) => void;
};

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function CommandPaletteView({
  snapshot,
  actions,
}: {
  snapshot: CommandPaletteSnapshot;
  actions: CommandPaletteViewActions;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!snapshot.open) {
      inputRef.current?.blur();
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [snapshot.focusToken, snapshot.open]);

  useEffect(() => {
    if (!snapshot.open) {
      return;
    }
    listRef.current
      ?.querySelector<HTMLElement>("[data-command-active=\"true\"]")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [snapshot.items, snapshot.open, snapshot.selectedIndex]);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      actions.close();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      actions.moveSelection(1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      actions.moveSelection(-1);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      actions.runSelected();
    }
  };

  return (
    <section
      class="command-palette"
      role="dialog"
      aria-label="Command palette"
      hidden={!snapshot.open}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          actions.close();
        }
      }}
      onKeyDown={onKeyDown}
    >
      <div class="command-palette-panel">
        <input
          ref={inputRef}
          type="text"
          autoComplete="off"
          placeholder="Search apps and windows"
          value={snapshot.query}
          onInput={(event) => actions.setQuery(event.currentTarget.value)}
        />
        <button type="button" class="command-palette-close" aria-label="Close search" onClick={() => actions.close()}>
          <CloseIcon />
        </button>
        <ul class="command-palette-list" ref={listRef}>
          {snapshot.items.length === 0 ? (
            <li class="command-palette-empty">No results</li>
          ) : snapshot.items.map((item, index) => (
            <li key={item.id}>
              <button
                type="button"
                class={index === snapshot.selectedIndex ? "command-palette-item is-active" : "command-palette-item"}
                data-command-active={index === snapshot.selectedIndex ? "true" : "false"}
                onClick={() => actions.runAt(index)}
              >
                <span class="command-palette-icon" aria-hidden="true">
                  <DesktopAppIconGlyph icon={item.icon} />
                </span>
                <span class="command-palette-label gsv-prose">{item.label}</span>
                <small>{item.meta}</small>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function createCommandPalette(options: CommandPaletteOptions): CommandPaletteController {
  let snapshot: CommandPaletteSnapshot = {
    open: false,
    query: "",
    selectedIndex: 0,
    items: [],
    focusToken: 0,
  };

  function filteredItems(query: string): readonly CommandPaletteActionItem[] {
    return filterLauncherPaletteItems(options.getItems(), query);
  }

  function clampSelection(items: readonly CommandPaletteActionItem[], selectedIndex: number): number {
    return Math.min(Math.max(selectedIndex, 0), Math.max(items.length - 1, 0));
  }

  function render(): void {
    renderPreact(<CommandPaletteView snapshot={snapshot} actions={actions} />, options.rootNode);
  }

  function setSnapshot(next: CommandPaletteSnapshot): void {
    snapshot = next;
    render();
  }

  function close(): void {
    if (!snapshot.open) {
      return;
    }
    setSnapshot({ ...snapshot, open: false });
    options.onClose();
  }

  function open(): void {
    options.onOpen();
    const items = filteredItems("");
    setSnapshot({
      open: true,
      query: "",
      selectedIndex: 0,
      items,
      focusToken: snapshot.focusToken + 1,
    });
  }

  function moveSelection(delta: number): void {
    if (!snapshot.open || snapshot.items.length === 0) {
      return;
    }
    setSnapshot({
      ...snapshot,
      selectedIndex: clampSelection(snapshot.items, snapshot.selectedIndex + delta),
    });
  }

  function setQuery(query: string): void {
    const items = filteredItems(query);
    setSnapshot({
      ...snapshot,
      query,
      items,
      selectedIndex: 0,
    });
  }

  function runAt(index: number): void {
    const item = snapshot.items[index];
    if (!item) {
      return;
    }
    close();
    item.run();
  }

  const actions: CommandPaletteViewActions = {
    close,
    setQuery,
    moveSelection,
    runSelected: () => runAt(snapshot.selectedIndex),
    runAt,
  };

  render();

  return {
    open,
    close,
    toggle: () => {
      if (snapshot.open) {
        close();
      } else {
        open();
      }
    },
    refresh: () => {
      if (!snapshot.open) {
        return;
      }
      const items = filteredItems(snapshot.query);
      setSnapshot({
        ...snapshot,
        items,
        selectedIndex: clampSelection(items, snapshot.selectedIndex),
      });
    },
    isOpen: () => snapshot.open,
    destroy: () => {
      if (snapshot.open) {
        snapshot = { ...snapshot, open: false };
        options.onClose();
      }
      renderPreact(null, options.rootNode);
    },
  };
}
