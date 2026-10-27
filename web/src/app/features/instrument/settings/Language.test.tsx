import type { ComponentChildren, VNode } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { collectNodes, createTestRoot } from "../../../testing/testHarness";
import { Select, type SelectProps } from "../../../components/ui/Select";
import { Language } from "./Language";

afterEach(() => vi.unstubAllGlobals());

/** Language always passes labelled options; parsing them here keeps the assertions on that contract. */
const options = (select: VNode<SelectProps>) => z.array(z.object({ label: z.string(), value: z.string() })).parse(select.props.options);

it("offers exactly English, Spanish and Portuguese and maps regional saved values", async () => {
  vi.stubGlobal("document", {});
  const root = createTestRoot("Language dropdown");
  let tree: ComponentChildren;
  let value: string;
  function Harness() {
    const [draft, setDraft] = useState("en-GB");
    value = draft;
    tree = Language({ value: draft, editable: true, onChange: setDraft });
    return null;
  }
  // SAFETY: Language renders one design-system Select.
  const select = () => collectNodes(tree).find((node) => node.type === Select) as VNode<SelectProps>;
  const change = (value: string) => act(() => select().props.onSelect?.(value));
  try {
    await root.render(<Harness />);
    expect(select().props.selected).toBe("en");
    expect(value!).toBe("en-GB");
    expect(options(select()).map((option) => option.value)).toEqual(["en", "es", "pt-BR"]);
    await change("pt-BR");
    expect(value!).toBe("pt-BR");
    await change("es");
    expect(value!).toBe("es");
    expect(collectNodes(tree).some((node) => node.type === "input")).toBe(false);
  } finally { await root.unmount(); }
});

it.each([
  { saved: "fr", device: "en-US", label: "fr" },
  { saved: "nl", device: "es-MX", label: "nl" },
  { saved: "", device: "en-US", label: "Automatic" },
])("keeps the saved language '$saved' distinct from the interface fallback on $device", async ({ saved, device, label }) => {
  vi.stubGlobal("document", {});
  vi.stubGlobal("navigator", { languages: [device] });
  const root = createTestRoot("Saved language");
  let tree: ComponentChildren;
  const changed = vi.fn();
  function Harness() {
    const [draft, setDraft] = useState(saved);
    tree = Language({ value: draft, editable: true, onChange: (value) => { changed(value); setDraft(value); } });
    return null;
  }
  // SAFETY: Language renders one design-system Select.
  const select = () => collectNodes(tree).find((node) => node.type === Select) as VNode<SelectProps>;
  try {
    await root.render(<Harness />);
    expect(select().props.selected).toBe(saved);
    expect(options(select()).find((option) => option.value === saved)?.label).toBe(label);
    expect(changed).not.toHaveBeenCalled();
    await act(() => select().props.onSelect?.("en"));
    expect(changed).toHaveBeenCalledWith("en");
    expect(select().props.selected).toBe("en");
  } finally { await root.unmount(); }
});
