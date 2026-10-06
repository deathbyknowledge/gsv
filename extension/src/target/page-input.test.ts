import { describe, expect, it } from "vitest";
import { keyEvent, parsePageKey } from "./page-input";

describe("page keyboard input", () => {
  it.each([" ", "Space", "Shift+Space"])("delivers %j as a printable space", (input) => {
    const key = parsePageKey(input);
    expect(key).toMatchObject({ key: " ", code: "Space", text: " " });
    expect(keyEvent("down", key)).toMatchObject({ type: "keyDown", text: " " });
    expect(keyEvent("up", key)).not.toHaveProperty("text");
  });

  it.each(["Ctrl+Space", "Alt+Space", "Meta+Space"])("does not insert text for shortcut %s", (input) => {
    const key = parsePageKey(input);
    expect(key).not.toHaveProperty("text");
    expect(keyEvent("down", key)).toMatchObject({ type: "rawKeyDown", code: "Space" });
  });
});
