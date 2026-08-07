import { describe, expect, it } from "vitest";
import {
  adapterAccountDurableObjectName,
  assertAdapterAccountDurableObjectIdentity,
  parseAdapterAccountDurableObjectName,
  parseAdapterInstallationContext,
  resolveAdapterAccountDurableObjectIdentity,
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

  it("derives installation identity from named Durable Objects", () => {
    expect(parseAdapterAccountDurableObjectName("default")).toEqual({
      installationId: "singleton",
      accountId: "default",
    });
    expect(parseAdapterAccountDurableObjectName(
      "account:inst_first:default%3Aaccount",
    )).toEqual({
      installationId: "inst_first",
      accountId: "default:account",
    });
  });

  it("rejects invalid and mismatched identity", () => {
    expect(() => parseAdapterInstallationContext({ installationId: "../other" }))
      .toThrow("Adapter installation context is invalid");
    expect(() => assertAdapterAccountDurableObjectIdentity(
      "account:inst_first:primary",
      "other",
    )).toThrow("Adapter account identity mismatch");
  });

  it("rejects names Cloudflare cannot expose through ctx.id.name", () => {
    expect(() => adapterAccountDurableObjectName(
      { installationId: "inst_first" },
      "a".repeat(1_025),
    )).toThrow("Adapter account Durable Object name is too long");
  });

  it("recovers persisted identity when an opaque lookup omits the DO name", () => {
    expect(resolveAdapterAccountDurableObjectIdentity(undefined, {
      installationId: "inst_first",
      accountId: "default",
    })).toEqual({
      installationId: "inst_first",
      accountId: "default",
    });
  });

  it("rejects persisted identity that disagrees with the DO name", () => {
    expect(() => resolveAdapterAccountDurableObjectIdentity(
      "account:inst_first:default",
      { installationId: "inst_second", accountId: "default" },
    )).toThrow("Adapter installation identity mismatch");
  });
});
