import { describe, expect, it } from "vitest";

import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { ResponsibilitySourcePolicyStore } from "./responsibility-source-policies";

describe("ResponsibilitySourcePolicyStore", () => {
  it("uses built-in defaults and isolates persisted owner overrides", async () => {
    await runWithRealKernelSql((sql) => {
      const policies = new ResponsibilitySourcePolicyStore(sql);

      expect(policies.list(1000)).toEqual([expect.objectContaining({
        id: "mail.received",
        enabled: true,
        defaultEnabled: true,
      })]);

      expect(policies.set(1000, "mail.received", false, 1234)).toEqual(
        expect.objectContaining({
          id: "mail.received",
          enabled: false,
          updatedAtMs: 1234,
        }),
      );
      expect(policies.isEnabled(1000, "mail.received")).toBe(false);
      expect(policies.isEnabled(1001, "mail.received")).toBe(true);
    });
  });
});
