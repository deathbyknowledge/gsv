import { describe, expect, it } from "vitest";
import { boundedBrowserOrigins, MAX_BROWSER_STORAGE_ORIGINS, rememberBrowserOrigin } from "../src/browser-origins";

describe("page-controlled browser origins", () => {
  it("bounds origin length and canonicalizes valid HTTP(S) origins", () => {
    const origins = boundedBrowserOrigins(["https://Example.com/path?x=1", "https://example.com/other", "http://example.com:80", "file:///tmp/file", "https://", `https://${"a".repeat(3000)}.example/`]);
    expect(origins).toEqual(["https://example.com", "http://example.com"]);
    expect(rememberBrowserOrigin(origins, `https://short.example/${"x".repeat(30000)}`)).toBe(true);
    expect(origins.at(-1)).toBe("https://short.example");
    expect(rememberBrowserOrigin(origins, "https://short.example/another")).toBe(false);
  });

  it("rejects an origin flood without displacing tracked sign-ins or requesting another persistence write", () => {
    const origins = ["https://signed-in.example"];
    for (let index = 0; index < MAX_BROWSER_STORAGE_ORIGINS - 1; index++) {
      expect(rememberBrowserOrigin(origins, `https://frame-${index}.example/`)).toBe(true);
    }
    const saved = [...origins];
    for (let index = 0; index < 1000; index++) expect(rememberBrowserOrigin(origins, `https://overflow-${index}.example/`)).toBe(false);
    expect(origins).toEqual(saved);
    expect(origins).toHaveLength(MAX_BROWSER_STORAGE_ORIGINS);
    expect(origins[0]).toBe("https://signed-in.example");
  });

  it("bounds recovered and restored origins, deduplicating before applying the limit", () => {
    const origins = Array.from({ length: 1000 }, (_, index) => `https://site-${index}.example`);
    expect(boundedBrowserOrigins(origins.slice(0, 10), origins)).toEqual(origins.slice(0, MAX_BROWSER_STORAGE_ORIGINS));
    expect(boundedBrowserOrigins(origins)).toEqual(origins.slice(0, MAX_BROWSER_STORAGE_ORIGINS));
    expect(boundedBrowserOrigins([], origins)).toEqual(origins.slice(0, MAX_BROWSER_STORAGE_ORIGINS));
  });
});
