import { describe, expect, it } from "vitest";
import { keyEvent, parsePageKey } from "./page-input";

describe("page keyboard input", () => {
  it.each(["Enter", "Return", "Shift+Enter"])("delivers %s with native form and editing behavior", (input) => {
    const key = parsePageKey(input);
    expect(key).toMatchObject({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    expect(keyEvent("down", key)).toMatchObject({ type: "keyDown", text: "\r", unmodifiedText: "\r" });
    expect(keyEvent("up", key)).toMatchObject({ type: "keyUp", key: "Enter" });
    expect(keyEvent("up", key)).not.toHaveProperty("text");
  });

  it.each([" ", "Space", "Shift+Space"])("delivers %j as a printable space", (input) => {
    const key = parsePageKey(input);
    expect(key).toMatchObject({ key: " ", code: "Space", text: " " });
    expect(keyEvent("down", key)).toMatchObject({ type: "keyDown", text: " " });
    expect(keyEvent("up", key)).not.toHaveProperty("text");
  });

  it.each(["Ctrl+Space", "Alt+Space", "Meta+Space", "Ctrl+Enter", "Alt+Return", "Meta+Enter"])("does not insert text for shortcut %s", (input) => {
    const key = parsePageKey(input);
    expect(key).not.toHaveProperty("text");
    expect(keyEvent("down", key)).toMatchObject({ type: "rawKeyDown", code: key.code });
  });
});
