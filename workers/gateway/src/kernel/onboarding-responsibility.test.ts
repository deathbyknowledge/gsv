import { describe, expect, it } from "vitest";

import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { ensureInitialOnboardingResponsibility } from "./onboarding-responsibility";
import { ResponsibilityStore } from "./responsibility-store";

describe("initial onboarding responsibility", () => {
  it("creates one non-waking Ship responsibility for the owner", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const responsibilities = new ResponsibilityStore(storage);
      const first = ensureInitialOnboardingResponsibility(1000, responsibilities, 1_000);
      const replay = ensureInitialOnboardingResponsibility(1000, responsibilities, 2_000);

      expect(first.created).toBe(true);
      expect(first.record).toMatchObject({
        ownerUid: 1000,
        title: "Get to know the user and finish initial GSV setup",
        source: { kind: "system", component: "onboarding" },
        assignee: { kind: "ship" },
        state: "waiting",
        priority: "high",
        blocker: "Waiting for the user to begin or continue setup.",
        details: {
          responsibilityType: "onboarding.initial",
          completionCondition: "The user confirms that onboarding or setup is complete.",
        },
      });
      expect(replay).toEqual({
        record: first.record,
        created: false,
        revision: first.revision,
      });
      expect(responsibilities.nextWakeAt(1000, 2_000)).toBeNull();
    });
  });
});
