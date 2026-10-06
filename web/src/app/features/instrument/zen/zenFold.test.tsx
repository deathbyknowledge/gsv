import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRoot } from "../../../testing/testHarness";
import { FOLD_AFTER_LINES, lineHeight, useFold } from "./zenFold";

let root: ReturnType<typeof createTestRoot> | undefined;
beforeEach(() => { vi.stubGlobal("document", {}); });
afterEach(async () => { await root?.unmount(); root = undefined; vi.unstubAllGlobals(); });

async function fold(live: boolean, opened = false) {
  let current!: ReturnType<typeof useFold>;
  function Harness({ live }: { live: boolean }) {
    current = useFold(live, opened);
    return null;
  }
  root = createTestRoot("Message fold");
  await root.render(<Harness live={live} />);
  return {
    get: () => current,
    rerender: (next: boolean) => root!.render(<Harness live={next} />),
  };
}

describe("message folding", () => {
  it("keeps a message whole until it is longer than the fold", async () => {
    const message = await fold(false);
    expect(message.get().state).toBe("whole");
    await act(() => message.get().measured(FOLD_AFTER_LINES));
    expect(message.get().state).toBe("whole");
    await act(() => message.get().measured(FOLD_AFTER_LINES + 1));
    expect(message.get().state).toBe("folded");
  });

  it("opens and folds again from the toggle", async () => {
    const message = await fold(false);
    await act(() => message.get().measured(80));
    expect(message.get().state).toBe("folded");
    await act(() => message.get().toggle());
    expect(message.get().state).toBe("open");
    await act(() => message.get().toggle());
    expect(message.get().state).toBe("folded");
    await act(() => message.get().open());
    expect(message.get().state).toBe("open");
  });

  it("never folds a live message, and folds it once it has arrived", async () => {
    const message = await fold(true);
    await act(() => message.get().measured(80));
    expect(message.get().state).toBe("whole");
    await message.rerender(false);
    expect(message.get().state).toBe("folded");
  });

  it("leaves a message the reader watched arrive open", async () => {
    const message = await fold(false, true);
    await act(() => message.get().measured(80));
    expect(message.get().state).toBe("open");
    await act(() => message.get().toggle());
    expect(message.get().state).toBe("folded");
  });

  it("unfolds when the message reflows short enough", async () => {
    const message = await fold(false);
    await act(() => message.get().measured(80));
    await act(() => message.get().measured(12));
    expect(message.get().state).toBe("whole");
  });
});

describe("line height", () => {
  it("reads pixels, multiplies unitless heights and falls back for normal", () => {
    expect(lineHeight({ fontSize: "20px", lineHeight: "25.6px" })).toBe(25.6);
    expect(lineHeight({ fontSize: "20px", lineHeight: "1.5" })).toBe(30);
    expect(lineHeight({ fontSize: "20px", lineHeight: "normal" })).toBe(24);
    expect(lineHeight({ fontSize: "", lineHeight: "" })).toBeCloseTo(19.2);
  });
});
