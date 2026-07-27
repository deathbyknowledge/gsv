import { describe, expect, it } from "vitest";
import { findAppFrameEntrypoint } from "./do";
import type { PackageEntrypoint } from "./packages";

const ENTRYPOINTS: PackageEntrypoint[] = [
  {
    name: "Wiki",
    kind: "ui",
    module: "index.js",
    route: "/apps/wiki",
    syscalls: ["repo.list"],
  },
  {
    name: "wiki",
    kind: "command",
    module: "index.js",
    command: "wiki",
    syscalls: ["repo.list"],
  },
];

describe("findAppFrameEntrypoint", () => {
  it("matches UI app frames by entrypoint name and route", () => {
    expect(findAppFrameEntrypoint(ENTRYPOINTS, "Wiki", "/apps/wiki")).toBe(ENTRYPOINTS[0]);
    expect(findAppFrameEntrypoint(ENTRYPOINTS, "Wiki", "/apps/other")).toBeNull();
  });

  it("matches command app frames by command name", () => {
    expect(findAppFrameEntrypoint(ENTRYPOINTS, "wiki", "/apps/wiki")).toBe(ENTRYPOINTS[1]);
  });
});
