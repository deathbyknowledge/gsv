import type { ComponentChildren, JSX, VNode } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { collectNodes, createTestRoot } from "../../../testing/testHarness";
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
