import type { ComponentChildren, JSX, VNode } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { Language } from "./Language";

afterEach(() => vi.unstubAllGlobals());

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
  // SAFETY: These are Language's native fields; their handlers read currentTarget.value only.
  const select = () => collectNodes(tree).find((node) => node.type === "select") as VNode<JSX.SelectHTMLAttributes<HTMLSelectElement>>;
  // SAFETY: The change handler reads only currentTarget.value.
  const change = (value: string) => act(() => select().props.onChange?.({ currentTarget: { value } } as JSX.TargetedEvent<HTMLSelectElement>));
  try {
    await root.render(<Harness />);
    expect(select().props.value).toBe("en");
    expect(value!).toBe("en-GB");
    expect(collectNodes(tree).filter((node) => node.type === "option").map((node) => node.props.value)).toEqual(["en", "es", "pt-BR"]);
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
  // SAFETY: Language renders a native select whose change handler reads only currentTarget.value.
  const select = () => collectNodes(tree).find((node) => node.type === "select") as VNode<JSX.SelectHTMLAttributes<HTMLSelectElement>>;
  try {
    await root.render(<Harness />);
    expect(select().props.value).toBe(saved);
    const savedOption = collectNodes(tree).find((node) => node.type === "option" && node.props.value === saved);
    expect(collectText(savedOption)).toBe(label);
    expect(changed).not.toHaveBeenCalled();
    // SAFETY: The native change handler only reads the selected value.
    await act(() => select().props.onChange?.({ currentTarget: { value: "en" } } as JSX.TargetedEvent<HTMLSelectElement>));
    expect(changed).toHaveBeenCalledWith("en");
    expect(select().props.value).toBe("en");
  } finally { await root.unmount(); }
});
