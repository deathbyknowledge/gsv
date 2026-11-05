import { describe, expect, it } from "vitest";
import { normalizeFilesRead, normalizeFilesTargets } from "./normalization";

describe("normalizeFilesTargets", () => {
  it("reads the sys.target.list response shape", () => {
    const targets = normalizeFilesTargets({
      targets: [
        { targetId: "macbook", label: "MacBook", online: true, platform: "darwin", description: "" },
        { targetId: "beacon", online: false, platform: "linux", lastSeenAt: 1_700_000_000_000 },
      ],
    });

    expect(targets).toEqual([
      { id: "beacon", label: "beacon", online: false, platform: "linux", description: "", ownerUsername: null, lastSeenAt: 1_700_000_000_000 },
      { id: "macbook", label: "MacBook", online: true, platform: "darwin", description: "", ownerUsername: null, lastSeenAt: null },
    ]);
  });

  it("ignores the pre-protocol-4 devices shape and entries without an id", () => {
    expect(normalizeFilesTargets({ devices: [{ deviceId: "macbook" }] })).toEqual([]);
    expect(normalizeFilesTargets({ targets: [{ label: "nameless" }] })).toEqual([]);
  });
});

describe("normalizeFilesRead", () => {
  it("keeps the content type and a truncated read", () => {
    const read = normalizeFilesRead({
      ok: true,
      path: "/notes/today.md",
      kind: "text",
      contentType: "text/markdown; charset=utf-8",
      content: "# Today",
      size: 40_000,
      lines: 1,
      truncated: true,
    }, "gsv", "/notes/today.md");

    expect(read).toMatchObject({
      ok: true,
      path: "/notes/today.md",
      directoryPath: "/notes",
      content: "# Today",
      contentType: "text/markdown; charset=utf-8",
      size: 40_000,
      lines: 1,
      truncated: true,
    });
  });

  it("reads a missing truncated flag as a complete read", () => {
    const read = normalizeFilesRead({
      ok: true,
      path: "/notes/today.md",
      kind: "text",
      contentType: "text/markdown",
      content: "# Today",
      size: 7,
      lines: 1,
    }, "gsv", "/notes/today.md");

    expect(read).toMatchObject({ ok: true, truncated: false });
  });

  it("leaves directory results unchanged", () => {
    const read = normalizeFilesRead({
      ok: true,
      path: "/notes",
      files: ["today.md"],
      directories: ["archive"],
    }, "gsv", "/notes");

    expect(read).toEqual({
      ok: true,
      target: "gsv",
      path: "/notes",
      pathStyle: "absolute",
      entries: [
        { name: "archive", path: "/notes/archive", kind: "directory" },
        { name: "today.md", path: "/notes/today.md", kind: "file" },
      ],
    });
  });
});
