import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FieldStatus } from "../../../components/ui/FieldStatus";
import { collectNodes, createTestRoot } from "../../../testing/testHarness";
import { CodeCopyButton } from "./codeCopy";
import { SetupCommand } from "./SetupCommand";

let tree: ComponentChildren;
let text = "gsv pair ABC";
const writeText = vi.fn<(text: string) => Promise<void>>();
function Harness() { tree = SetupCommand({ text, label: "Copy pair command" }); return null; }

const note = () => collectNodes(tree).find((node) => node.type === FieldStatus)?.props;
const copy = async () => {
  // SAFETY: the copy control's props are the test subject.
  const button = collectNodes(tree).find((node) => node.type === CodeCopyButton)?.props as { copy: () => void } | undefined;
  if (!button) throw new Error("expected the copy control");
  await act(async () => { button.copy(); });
};

let root: ReturnType<typeof createTestRoot>;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("document", {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  writeText.mockReset().mockResolvedValue();
  text = "gsv pair ABC";
  root = createTestRoot("setup command");
  await root.render(<Harness />);
});
afterEach(async () => {
  await root.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("setup command", () => {
  it("copies the command exactly and shows the outcome under it for a moment", async () => {
    await copy();
    expect(writeText).toHaveBeenCalledWith("gsv pair ABC");
    expect(note()).toMatchObject({ status: "success", message: "copied", live: true });
    await act(async () => { vi.advanceTimersByTime(1_999); });
    expect(note()?.message).toBe("copied");
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(note()?.message).toBe("");
  });

  it("starts the moment again on a repeated copy", async () => {
    await copy();
    await act(async () => { vi.advanceTimersByTime(1_500); });
    await copy();
    await act(async () => { vi.advanceTimersByTime(1_500); });
    expect(note()?.message).toBe("copied");
  });

  it("says copying failed where the page has no clipboard at all", async () => {
    vi.stubGlobal("navigator", {});
    await copy();
    expect(note()).toMatchObject({ status: "error", message: "couldn't copy" });
  });

  it("says when the browser refuses to copy, and rests when the command changes", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    await copy();
    expect(note()).toMatchObject({ status: "error", message: "couldn't copy" });
    text = "gsv pair XYZ";
    await act(async () => { await root.render(<Harness />); });
    expect(note()?.message).toBe("");
  });
});
