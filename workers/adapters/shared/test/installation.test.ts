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

  it("keeps legacy construction while rejecting malformed scoped identities", () => {
    expect(adapterAccountDurableObjectName(
      { installationId: "singleton" },
      "account:inst_first:default",
    )).toBe("account:inst_first:default");
    expect(() => parseAdapterAccountDurableObjectName("account:default"))
      .toThrow("name is invalid");
    expect(() => parseAdapterAccountDurableObjectName("account:singleton:default"))
      .toThrow("name is invalid");
    expect(() => parseAdapterAccountDurableObjectName("account:inst_first:"))
      .toThrow("name is invalid");
    expect(() => parseAdapterAccountDurableObjectName("account:inst_first:%"))
      .toThrow("name is invalid");
    expect(() => parseAdapterAccountDurableObjectName(
      "account:inst_first:%64efault",
    )).toThrow("name is invalid");
  });

  it("recovers a reserved standalone name only from matching legacy state", () => {
    const name = "account:legacy:raw";
    expect(resolveAdapterAccountDurableObjectIdentity(name, {
      accountId: name,
    })).toEqual({
      installationId: "singleton",
      accountId: name,
    });
    expect(resolveAdapterAccountDurableObjectIdentity(name, {
      installationId: "singleton",
      accountId: name,
    })).toEqual({
      installationId: "singleton",
      accountId: name,
    });
    const malformedName = "account:singleton:raw";
    expect(resolveAdapterAccountDurableObjectIdentity(malformedName, {
      accountId: malformedName,
    })).toEqual({
      installationId: "singleton",
      accountId: malformedName,
    });
    expect(() => resolveAdapterAccountDurableObjectIdentity(malformedName, {}))
      .toThrow("name is invalid");
    expect(() => resolveAdapterAccountDurableObjectIdentity(malformedName, {
      accountId: "other",
    })).toThrow("name is invalid");
    expect(() => resolveAdapterAccountDurableObjectIdentity(malformedName, {
      installationId: "inst_first",
      accountId: malformedName,
    })).toThrow("name is invalid");
  });

  it("rejects names Cloudflare cannot expose through ctx.id.name", () => {
    expect(() => adapterAccountDurableObjectName(
      { installationId: "inst_first" },
      "a".repeat(1_025),
    )).toThrow("Adapter account Durable Object name is too long");
    expect(() => parseAdapterAccountDurableObjectName("a".repeat(1_025)))
      .toThrow("Adapter account Durable Object name is too long");
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
