import { describe, expect, it } from "vitest";
import {
  DO_LOGICAL_SNAPSHOT_SCHEMA_FEATURE,
  PORTABLE_ARCHIVE_V1_SCHEMA_FEATURES,
  R2_LOGICAL_SNAPSHOT_SCHEMA_FEATURE,
  RIPGIT_LOGICAL_SNAPSHOT_SCHEMA_FEATURE,
  WORKERS_KV_LOGICAL_SNAPSHOT_SCHEMA_FEATURE,
} from "../src/index";

describe("portable schema features", () => {
  it("pins the canonical v1 body-codec negotiation tokens", () => {
    expect(PORTABLE_ARCHIVE_V1_SCHEMA_FEATURES).toEqual([
      "gsv-do-logical-snapshot-v1",
      "gsv-r2-logical-snapshot-v1",
      "gsv-ripgit-logical-snapshot-v1",
      "gsv-workers-kv-logical-snapshot-v1",
    ]);
    expect(DO_LOGICAL_SNAPSHOT_SCHEMA_FEATURE).toBe(
      "gsv-do-logical-snapshot-v1",
    );
    expect(R2_LOGICAL_SNAPSHOT_SCHEMA_FEATURE).toBe(
      "gsv-r2-logical-snapshot-v1",
    );
    expect(RIPGIT_LOGICAL_SNAPSHOT_SCHEMA_FEATURE).toBe(
      "gsv-ripgit-logical-snapshot-v1",
    );
    expect(WORKERS_KV_LOGICAL_SNAPSHOT_SCHEMA_FEATURE).toBe(
      "gsv-workers-kv-logical-snapshot-v1",
    );
    expect(Object.isFrozen(PORTABLE_ARCHIVE_V1_SCHEMA_FEATURES)).toBe(true);
  });
});
