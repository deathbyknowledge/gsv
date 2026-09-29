import { describe, expect, it } from "vitest";
import { spaceAddress } from "./spaceAddress";

describe("Desktop space addresses", () => {
  it.each([
    ["esteve", "https://esteve.gsv.space"],
    [" Studio-2 ", "https://studio-2.gsv.space"],
    ["esteve.gsv.space", "https://esteve.gsv.space"],
    ["my.example:8443", "https://my.example:8443"],
    ["https://MY.EXAMPLE/", "https://my.example"],
    ["my.example/ws", "https://my.example"],
    ["https://my.example/ws/", "https://my.example"],
    ["wss://my.example/ws", "https://my.example"],
    ["localhost", "http://localhost"],
    ["localhost:8787/ws", "http://localhost:8787"],
    ["localhost:443", "http://localhost:443"],
    ["127.0.0.1:8787", "http://127.0.0.1:8787"],
    ["[::1]:8787", "http://[::1]:8787"],
    ["ws://localhost:8787/ws", "http://localhost:8787"],
    ["https://localhost:8787", "https://localhost:8787"],
  ])("resolves %s to %s", (input, origin) => {
    expect(spaceAddress(input).origin).toBe(origin);
  });

  it("shows the managed suffix only for handle input", () => {
    for (const input of ["", "esteve", " Studio-2 "]) expect(spaceAddress(input).suffix).toBe(".gsv.space");
    for (const input of ["esteve.gsv.space", "my.example", "https://my.example", "wss://my.example/ws", "localhost"]) {
      expect(spaceAddress(input).suffix).toBe("");
    }
  });

  it.each([
    "", " ", "-handle", "handle-", "a".repeat(64), "two words", "my.\nexample", "https:\\my.example",
    "https://name:secret@my.example", "name@my.example", "https://my.example?secret=value",
    "https://my.example/#secret", "my.example/settings", "http://my.example", "ws://my.example/ws",
    "file:///tmp/ui", "javascript:alert(1)", "ftp://my.example", "https:///",
  ])("rejects %s without selecting another destination", (input) => {
    expect(spaceAddress(input).origin).toBeNull();
  });
});
