import { describe, expect, it } from "vitest";
import { normalizeFilesTargets } from "./normalization";

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
