import { describe, expect, it } from "vitest";

import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { ResponsibilitySourcePolicyStore } from "./responsibility-source-policies";

describe("ResponsibilitySourcePolicyStore", () => {
  it("uses built-in defaults and isolates persisted owner overrides", async () => {
    await runWithRealKernelSql((sql) => {
      const policies = new ResponsibilitySourcePolicyStore(sql);

      expect(policies.list(1000).map(({ id, control, enabled }) => ({
        id,
        control,
        enabled,
      }))).toEqual([
        { id: "interaction.response", control: "required", enabled: true },
        { id: "process.delegation", control: "required", enabled: true },
        { id: "schedule.due", control: "required", enabled: true },
        { id: "mail.received", control: "configurable", enabled: true },
        { id: "federation.received", control: "configurable", enabled: true },
        { id: "contact.added", control: "configurable", enabled: true },
        { id: "machine.added", control: "configurable", enabled: true },
        { id: "adapter.connected", control: "configurable", enabled: true },
        { id: "adapter.auth_required", control: "configurable", enabled: true },
      ]);

      expect(policies.set(1000, "mail.received", false, 1234)).toEqual(
        expect.objectContaining({
          id: "mail.received",
          control: "configurable",
          enabled: false,
          updatedAtMs: 1234,
        }),
      );
      expect(policies.isEnabled(1000, "mail.received")).toBe(false);
      expect(policies.isEnabled(1001, "mail.received")).toBe(true);
    });
  });
});
