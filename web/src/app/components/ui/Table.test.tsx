import type { ComponentChildren, VNode } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectNodes, collectText, createTestRoot } from "../../testing/testHarness";
import { IconButton, type IconButtonProps } from "./IconButton";
import { TextInput } from "./TextInput";
import { Table, dropIndex, visibleRows, type TableColumn, type TableProps } from "./Table";

type Fruit = { name: string; kg: number };
const columns: TableColumn<Fruit>[] = [
  { key: "name", header: "Fruit", phone: "title", text: (row) => row.name, cell: (row) => row.name },
  { key: "kg", header: "Weight", align: "end", cell: (row) => String(row.kg) },
];
const fruit: Fruit[] = [{ name: "apple", kg: 1 }, { name: "pear", kg: 2 }, { name: "plum", kg: 3 }];

async function mounted(props: Partial<TableProps<Fruit>>) {
  const root = createTestRoot("table");
  let tree: ComponentChildren;
  const onMove = vi.fn();
  function Harness() {
    tree = Table<Fruit>({ caption: "Fruit", columns, rows: fruit, rowId: (row) => row.name, reorder: { onMove, label: (row) => row.name }, ...props });
    return null;
  }
  await root.render(<Harness />);
  const nodes = () => collectNodes(tree);
  // SAFETY: an IconButton node carries IconButtonProps, whose ariaLabel the controls set.
  const buttons = (name: string) => nodes().filter((node) => node.type === IconButton && String((node.props as IconButtonProps).ariaLabel).startsWith(name));
  return { nodes, buttons, onMove, unmount: () => root.unmount() };
}

describe("dropIndex", () => {
  it("lands a dragged row where the pointer released, in the order without that row", () => {
    expect(dropIndex(0, 2, false)).toBe(1);
    expect(dropIndex(0, 2, true)).toBe(2);
    expect(dropIndex(2, 0, false)).toBe(0);
    expect(dropIndex(2, 0, true)).toBe(1);
    expect(dropIndex(1, 1, false)).toBe(1);
  });
});

describe("visibleRows", () => {
  it("keeps every row for a blank query and matches searchable columns case-insensitively", () => {
    expect(visibleRows(fruit, columns, "  ").map((entry) => entry.index)).toEqual([0, 1, 2]);
    expect(visibleRows(fruit, columns, "PL").map((entry) => entry.row.name)).toEqual(["apple", "plum"]);
    expect(visibleRows(fruit, columns, "2")).toEqual([]);
  });
});

describe("Table", () => {
  beforeEach(() => vi.stubGlobal("document", {}));
  afterEach(() => vi.unstubAllGlobals());

  it("draws one header over the rows with reorder controls that stop at the ends", async () => {
    const view = await mounted({});
    try {
      const headers = view.nodes().filter((node) => node.type === "th").map((node) => collectText(node));
      expect(headers).toEqual(["Order", "Fruit", "Weight"]);
      expect(view.nodes().filter((node) => node.type === "tr")).toHaveLength(4);
      const up = view.buttons("Move up");
      const down = view.buttons("Move down");
      expect(up.map((node) => node.props.disabled)).toEqual([true, false, false]);
      expect(down.map((node) => node.props.disabled)).toEqual([false, false, true]);
      await act(() => { down[0].props.onClick?.(); });
      expect(view.onMove).toHaveBeenCalledWith(0, 1);
    } finally { await view.unmount(); }
  });

  it("filters rows by the search and pauses reordering while a query is set", async () => {
    const view = await mounted({ search: {} });
    try {
      // SAFETY: the search field is the one TextInput the table renders.
      const field = () => view.nodes().find((node) => node.type === TextInput) as VNode<{ onChange: (value: string) => void }>;
      await act(() => { field().props.onChange("ar"); });
      expect(view.nodes().filter((node) => node.type === "tr")).toHaveLength(2);
      expect(view.buttons("Move up").every((node) => node.props.disabled)).toBe(true);
      await act(() => { field().props.onChange("zzz"); });
      expect(collectText(view.nodes().find((node) => String(node.props.class).includes("gsv-table-state"))!)).toContain("zzz");
    } finally { await view.unmount(); }
  });

  it("replaces the table with its empty, loading and error states", async () => {
    const empty = await mounted({ rows: [], empty: "Nothing here" });
    try {
      expect(empty.nodes().some((node) => node.type === "table")).toBe(false);
      expect(collectText(empty.nodes()[0])).toContain("Nothing here");
    } finally { await empty.unmount(); }
    const failed = await mounted({ error: "Could not load" });
    try {
      expect(failed.nodes().some((node) => node.type === "table")).toBe(false);
      expect(failed.nodes().some((node) => node.props.role === "alert")).toBe(true);
    } finally { await failed.unmount(); }
  });
});
