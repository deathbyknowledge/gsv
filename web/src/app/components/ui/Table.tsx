import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { IconButton } from "./IconButton";
import { TextInput } from "./TextInput";
import { Hint } from "./Tooltip";
import { useT } from "../../i18n/locale";
import "./Table.css";

export type TableAlign = "start" | "end";
/** Where a column lands when the rows stack into blocks on a narrow surface. */
export type TablePhoneRole = "title" | "detail" | "hidden";

export interface TableColumn<Row> {
  key: string;
  header: string;
  /** Text starts, numbers end. */
  align?: TableAlign;
  phone?: TablePhoneRole;
  cell: (row: Row, index: number) => ComponentChildren;
  /** A help tip for one row's value. It sits beside the value in the grid, where every row reserves its slot so
   *  values line up, and beside the column label in a block. */
  info?: (row: Row, index: number) => ComponentChildren;
  /** The cell's words for search; a column without it is not searched. */
  text?: (row: Row) => string;
}

export interface TableReorder<Row> {
  /** `to` is the row's index once moved. */
  onMove: (from: number, to: number) => void;
  disabled?: boolean;
  /** Names a row in the move controls and the announcement ("Rule 3"). */
  label: (row: Row, index: number) => string;
}

export interface TableProps<Row> {
  /** Names the table for assistive technology; not drawn. */
  caption: string;
  columns: readonly TableColumn<Row>[];
  rows: readonly Row[];
  rowId: (row: Row, index: number) => string;
  density?: "default" | "compact";
  /** Below this width in px, the table's own, rows stack into blocks unless `phone` is "scroll". */
  narrowBelow?: number;
  /** "stacked" turns rows into blocks on a narrow surface; "scroll" keeps the grid and scrolls it sideways. */
  phone?: "stacked" | "scroll";
  stickyHeader?: boolean;
  reorder?: TableReorder<Row>;
  /** Trailing controls for a row, usually icon buttons. */
  rowActions?: (row: Row, index: number) => ComponentChildren;
  /** Shows a search field above the table, matching the columns that give `text`. */
  search?: { label?: string; placeholder?: string };
  /** Replaces the table while there are no rows. */
  empty?: ComponentChildren;
  loading?: boolean;
  /** Replaces the table while the rows could not be loaded. */
  error?: ComponentChildren;
}

type Drag = { from: number; over: number | null; after: boolean; pointerId: number };

const SEARCH_GLYPH = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" aria-hidden="true">
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5 L14 14" />
  </svg>
);

/** Where a dragged row lands: the hovered row's index, shifted when the pointer is past its middle and when the
 *  row leaves from above. */
export function dropIndex(from: number, over: number, after: boolean): number {
  const slot = over + (after ? 1 : 0);
  return from < slot ? slot - 1 : slot;
}

/** Rows that stay in view for a query: every row while the query is blank, else those whose searchable
 *  columns contain it, case-insensitively. Original indexes come along so controls act on the real row. */
export function visibleRows<Row>(rows: readonly Row[], columns: readonly TableColumn<Row>[], query: string): Array<{ row: Row; index: number }> {
  const needle = query.trim().toLocaleLowerCase();
  const searchable = columns.filter((column) => column.text);
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => needle === "" || searchable.some((column) => column.text!(row).toLocaleLowerCase().includes(needle)));
}

/** Table — rows of data or controls under one header. On a narrow surface the same rows render as a list of
 *  blocks, a real list rather than a restyled table, so both read correctly. Reordering offers a drag handle
 *  and move buttons, with each move announced; search filters by the columns that give text. */
export function Table<Row>({ caption, columns, rows, rowId, density = "default", narrowBelow = 640, phone = "stacked", stickyHeader = false, reorder, rowActions, search, empty, loading = false, error }: TableProps<Row>) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [query, setQuery] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [moved, setMoved] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const scrollLoop = useRef(0);

  useEffect(() => {
    const element = host.current;
    if (!element || !("ResizeObserver" in window)) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setNarrow(width > 0 && width < narrowBelow);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [narrowBelow]);

  useEffect(() => {
    if (moved === null) return;
    const settle = setTimeout(() => setMoved(null), 700);
    return () => clearTimeout(settle);
  }, [moved]);

  const searching = query.trim() !== "";
  const shown = visibleRows(rows, columns, query);
  const canReorder = !!reorder && !reorder.disabled && !searching && rows.length > 1;
  const move = (from: number, to: number) => {
    if (!reorder || to < 0 || to >= rows.length || to === from) return;
    reorder.onMove(from, to);
    setMoved(rowId(rows[from], from));
    setAnnouncement(t("ui.table.moved", { label: reorder.label(rows[from], from), position: to + 1, count: rows.length }));
  };

  /** The nearest ancestor that scrolls, else the page: what a drag near an edge moves. */
  const scroller = (): Element | null => {
    for (let node = host.current?.parentElement ?? null; node; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowY;
      if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node;
    }
    return document.scrollingElement;
  };
  // While a drag sits near the top or bottom of the view, the view scrolls so rows out of sight can be reached.
  const trackEdges = () => {
    const current = dragRef.current;
    const at = pointer.current;
    if (!current || !at) return;
    const edge = 56;
    const pane = scroller();
    // The zones sit at the edges of what actually scrolls: a pane's own box when a pane scrolls, the viewport otherwise.
    const box = pane && pane !== document.scrollingElement ? pane.getBoundingClientRect() : null;
    const viewTop = Math.max(0, box?.top ?? 0);
    const viewBottom = Math.min(window.innerHeight, box?.bottom ?? window.innerHeight);
    const speed = at.y < viewTop + edge ? -Math.ceil((viewTop + edge - at.y) / 4) : at.y > viewBottom - edge ? Math.ceil((at.y - (viewBottom - edge)) / 4) : 0;
    if (speed !== 0) {
      pane?.scrollBy(0, speed);
      const hit = rowAt(at.x, at.y);
      const next = { ...current, over: hit?.index ?? null, after: hit?.after ?? false };
      dragRef.current = next;
      setDrag(next);
    }
    scrollLoop.current = requestAnimationFrame(trackEdges);
  };
  const stopEdges = () => {
    if (scrollLoop.current) cancelAnimationFrame(scrollLoop.current);
    scrollLoop.current = 0;
  };
  const stopDrag = () => {
    dragRef.current = null;
    pointer.current = null;
    stopEdges();
    setDrag(null);
  };
  useEffect(() => stopEdges, []);

  const rowAt = (x: number, y: number): { index: number; after: boolean } | null => {
    const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-table-row]");
    if (!hit || !host.current?.contains(hit)) return null;
    const index = Number(hit.dataset.tableRow);
    const bounds = hit.getBoundingClientRect();
    return { index, after: y > bounds.top + bounds.height / 2 };
  };
  const handleProps = (index: number) => ({
    onPointerDown: (event: PointerEvent) => {
      if (!canReorder || (event.pointerType === "mouse" && event.button !== 0)) return;
      event.preventDefault();
      const next = { from: index, over: null, after: false, pointerId: event.pointerId };
      dragRef.current = next;
      pointer.current = { x: event.clientX, y: event.clientY };
      setDrag(next);
      // SAFETY: the handlers are attached to the grip wrapper, an element.
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      stopEdges();
      scrollLoop.current = requestAnimationFrame(trackEdges);
    },
    onPointerMove: (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current || current.pointerId !== event.pointerId) return;
      pointer.current = { x: event.clientX, y: event.clientY };
      const hit = rowAt(event.clientX, event.clientY);
      const next = { ...current, over: hit?.index ?? null, after: hit?.after ?? false };
      dragRef.current = next;
      setDrag(next);
    },
    onPointerUp: (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current || current.pointerId !== event.pointerId) return;
      stopDrag();
      if (current.over !== null) move(current.from, dropIndex(current.from, current.over, current.after));
    },
    onPointerCancel: () => stopDrag(),
    onLostPointerCapture: () => stopDrag(),
    onKeyDown: (event: KeyboardEvent) => {
      if (!canReorder) return;
      if (event.key === "ArrowUp") { event.preventDefault(); move(index, index - 1); }
      if (event.key === "ArrowDown") { event.preventDefault(); move(index, index + 1); }
    },
  });

  const controls = (row: Row, index: number) => {
    if (!reorder) return null;
    const label = reorder.label(row, index);
    const blocked = reorder.disabled || searching;
    const hint = (text: string) => (searching ? t("ui.table.reorderWhileSearching") : text);
    return <span class="gsv-table-reorder">
      <Hint text={hint(t("ui.table.drag"))}>
        {/* The wrapper takes the pointer and key events: a drag needs capture on an element, and the button inside stays a plain button. */}
        <span class={`gsv-table-grip${canReorder ? "" : " is-idle"}`} {...handleProps(index)}>
          <IconButton glyph="grip" variant="floating" ariaLabel={`${t("ui.table.drag")}: ${label}`} disabled={blocked || rows.length < 2} />
        </span>
      </Hint>
      <Hint text={hint(t("ui.table.moveUp"))}>
        <IconButton glyph="arrowUp" variant="floating" ariaLabel={`${t("ui.table.moveUp")}: ${label}`} disabled={blocked || index === 0} onClick={() => move(index, index - 1)} />
      </Hint>
      <Hint text={hint(t("ui.table.moveDown"))}>
        <IconButton glyph="arrowDown" variant="floating" ariaLabel={`${t("ui.table.moveDown")}: ${label}`} disabled={blocked || index === rows.length - 1} onClick={() => move(index, index + 1)} />
      </Hint>
    </span>;
  };

  const rowClass = (row: Row, index: number) => {
    const id = rowId(row, index);
    const classes = ["gsv-table-row"];
    if (moved === id) classes.push("is-moved");
    if (drag?.from === index) classes.push("is-dragging");
    if (drag && drag.over === index && drag.from !== index) classes.push(drag.after ? "is-drop-after" : "is-drop-before");
    return classes.join(" ");
  };

  let body: ComponentChildren;
  if (error !== undefined && error !== null) {
    body = <div class="gsv-table-state is-error" role="alert">{error}</div>;
  } else if (loading) {
    body = <div class="gsv-table-state is-loading" role="status" aria-label={t("ui.table.loading")}>
      {[0, 1, 2].map((line) => <span key={line} class="gsv-table-skeleton" />)}
    </div>;
  } else if (rows.length === 0) {
    body = <div class="gsv-table-state is-empty">{empty}</div>;
  } else if (shown.length === 0) {
    body = <div class="gsv-table-state is-empty" role="status">{t("ui.table.noMatches", { query: query.trim() })}</div>;
  } else if (narrow && phone === "stacked") {
    const title = columns.find((column) => column.phone === "title");
    const details = columns.filter((column) => column !== title && column.phone !== "hidden");
    body = <ul class="gsv-table-list" aria-label={caption}>
      {shown.map(({ row, index }) => <li key={rowId(row, index)} class={`gsv-table-card ${rowClass(row, index)}`} data-table-row={index}>
        {title && <div class="gsv-table-card-title">{title.cell(row, index)}</div>}
        {details.map((column) => <div key={column.key} class="gsv-table-card-field">
          <span class="gsv-table-card-label gsv-sublabel">{column.header}{column.info && <span class="gsv-table-info">{column.info(row, index)}</span>}</span>
          <div class={column.align === "end" ? "is-end" : undefined}>{column.cell(row, index)}</div>
        </div>)}
        {(reorder || rowActions) && <div class="gsv-table-card-controls">{controls(row, index)}{rowActions && <span class="gsv-table-actions">{rowActions(row, index)}</span>}</div>}
      </li>)}
    </ul>;
  } else {
    body = <div class={`gsv-table-scroll${phone === "scroll" ? " is-scroll" : ""}`} tabIndex={phone === "scroll" ? 0 : undefined} aria-label={phone === "scroll" ? caption : undefined}>
      <table class="gsv-table-grid">
        <caption class="gsv-table-vh">{caption}</caption>
        <thead>
          <tr>
            {reorder && <th scope="col" class="gsv-table-th is-reorder"><span class="gsv-table-vh">{t("ui.table.order")}</span></th>}
            {columns.map((column) => <th key={column.key} scope="col" class={`gsv-table-th gsv-sublabel${column.align === "end" ? " is-end" : ""}`}>{column.header}</th>)}
            {rowActions && <th scope="col" class="gsv-table-th is-actions"><span class="gsv-table-vh">{t("ui.table.actions")}</span></th>}
          </tr>
        </thead>
        <tbody>
          {shown.map(({ row, index }) => <tr key={rowId(row, index)} class={rowClass(row, index)} data-table-row={index}>
            {reorder && <td class="gsv-table-td is-reorder">{controls(row, index)}</td>}
            {columns.map((column) => <td key={column.key} class={`gsv-table-td${column.align === "end" ? " is-end" : ""}`}>
              {column.info
                ? <span class="gsv-table-cell"><span class="gsv-table-value">{column.cell(row, index)}</span><span class="gsv-table-info">{column.info(row, index)}</span></span>
                : column.cell(row, index)}
            </td>)}
            {rowActions && <td class="gsv-table-td is-actions"><span class="gsv-table-actions">{rowActions(row, index)}</span></td>}
          </tr>)}
        </tbody>
      </table>
    </div>;
  }

  return <div ref={host} class={`gsv-table${density === "compact" ? " is-compact" : ""}${stickyHeader ? " is-sticky" : ""}${narrow ? " is-narrow" : ""}`}>
    {search && <div class="gsv-table-search">
      <TextInput size="small" label={search.label ?? t("ui.table.search")} placeholder={search.placeholder ?? t("ui.table.search")} prefix={SEARCH_GLYPH} clearable value={query} onChange={setQuery} />
    </div>}
    {body}
    <div class="gsv-table-vh" aria-live="polite">{announcement}</div>
  </div>;
}
