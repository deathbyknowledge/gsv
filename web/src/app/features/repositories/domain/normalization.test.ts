import { describe, expect, it } from "vitest";
import { normalizeRepositoryPull } from "./normalization";

describe("repository normalization", () => {
  it("normalizes upstream pull details", () => {
    expect(normalizeRepositoryPull({
      repo: "alice/demo",
      ref: "main",
      head: "local123",
      changed: false,
      remote_url: "https://github.com/example/demo",
      remote_ref: "main",
      tracking_ref: "refs/remotes/upstream/main",
      upstream_head: "upstream456",
      upstream_changed: true,
      local_changed: false,
      diverged: true,
    })).toEqual({
      repo: "alice/demo",
      ref: "main",
      head: "local123",
      changed: false,
      remoteUrl: "https://github.com/example/demo",
      remoteRef: "main",
      trackingRef: "refs/remotes/upstream/main",
      upstreamHead: "upstream456",
      upstreamChanged: true,
      localChanged: false,
      diverged: true,
    });
  });
});
