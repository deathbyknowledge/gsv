import { describe, expect, it } from "vitest";
import {
  adapterAccountDurableObjectName,
  assertAdapterInstallationIdentity,
  parseAdapterInstallationContext,
} from "../src/installation";

describe("adapter installation identity", () => {
  it("preserves standalone account Durable Object names", () => {
    expect(adapterAccountDurableObjectName(
      { installationId: "singleton" },
      "default",
    )).toBe("default");
  });

  it("scopes identical managed accounts without composite collisions", () => {
    expect(adapterAccountDurableObjectName(
      { installationId: "inst_first" },
      "default",
    )).toBe("account:inst_first:default");
    expect(adapterAccountDurableObjectName(
      { installationId: "inst_first:default" },
      "account",
    )).not.toBe(adapterAccountDurableObjectName(
      { installationId: "inst_first" },
      "default:account",
    ));
  });

  it("rejects invalid and mismatched identity", () => {
    expect(() => parseAdapterInstallationContext({ installationId: "../other" }))
      .toThrow("Adapter installation context is invalid");
    expect(() => assertAdapterInstallationIdentity(
      "inst_first",
      { installationId: "inst_second" },
    )).toThrow("Adapter installation identity mismatch");
  });
});
