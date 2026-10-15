import { describe, expect, it } from "vitest";
import { browserTemplate } from "../src/config";

const base = { enabled: true, concurrentInstances: 1, periodSeconds: 1000, maxInstanceSeconds: 600, profileStorageBytes: 1024 };

describe("browserTemplate", () => {
  it("advertises saved logins only when the space allows saved profiles", () => {
    expect(browserTemplate({ ...base, savedProfiles: 1 }).description).toContain("remember and restore this account's website logins");
    expect(browserTemplate({ ...base, savedProfiles: 0 }).description).toContain("Saved logins are not enabled for this space");
  });
});
