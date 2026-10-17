import { describe, expect, it } from "vitest";
import { spaceAddress } from "./spaceAddress";

const deployment = { primaryDomain: "fleet.example", legacyDomains: ["old.example"] };

describe("space addresses", () => {
  it.each([
    ["esteve", "https://esteve.fleet.example"],
    [" Studio-2 ", "https://studio-2.fleet.example"],
    ["esteve.fleet.example", "https://esteve.fleet.example"],
    ["my.example:8443", "https://my.example:8443"],
    ["https://MY.EXAMPLE/", "https://my.example"],
    ["my.example/ws", "https://my.example"],
    ["https://my.example/ws/", "https://my.example"],
    ["wss://my.example/ws", "https://my.example"],
    ["localhost", "http://localhost"],
    ["localhost:8787/ws", "http://localhost:8787"],
    ["my-space.localhost:8787", "http://my-space.localhost:8787"],
    ["http://my-space.localhost:8787", "http://my-space.localhost:8787"],
    ["localhost:443", "http://localhost:443"],
    ["127.0.0.1:8787", "http://127.0.0.1:8787"],
    ["[::1]:8787", "http://[::1]:8787"],
    ["ws://localhost:8787/ws", "http://localhost:8787"],
    ["https://localhost:8787", "https://localhost:8787"],
  ])("resolves %s to %s", (input, origin) => {
    expect(spaceAddress(input, deployment).origin).toBe(origin);
  });

  it("requires a configured domain for bare handles", () => {
    expect(spaceAddress("pilot", { legacyDomains: [] }).origin).toBeNull();
    expect(spaceAddress("pilot.other.example", { legacyDomains: [] }).origin).toBe("https://pilot.other.example");
  });

  it("shows the managed suffix only for handle input", () => {
    for (const input of ["", "esteve", " Studio-2 "]) expect(spaceAddress(input, deployment).suffix).toBe(".fleet.example");
    for (const input of ["esteve.fleet.example", "my.example", "https://my.example", "wss://my.example/ws", "localhost"]) {
      expect(spaceAddress(input, deployment).suffix).toBe("");
    }
  });

  it.each([
    "", " ", "-handle", "handle-", "a".repeat(64), "two words", "my.\nexample", "https:\\my.example",
    "https://name:secret@my.example", "name@my.example", "https://my.example?secret=value",
    "https://my.example/#secret", "my.example/settings", "http://my.example", "ws://my.example/ws",
    "file:///tmp/ui", "javascript:alert(1)", "ftp://my.example", "https:///",
  ])("rejects %s without selecting another destination", (input) => {
    expect(spaceAddress(input, deployment).origin).toBeNull();
  });
});
