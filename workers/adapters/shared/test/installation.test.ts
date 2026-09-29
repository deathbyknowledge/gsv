import { describe, expect, it } from "vitest";
import {
  adapterAccountDurableObjectName,
  parseAdapterAccountDurableObjectName,
  parseAdapterInstallationContext,
} from "../src/installation";

describe("adapter installation identity", () => {
  it("requires explicit scope even for the former reserved installation ID", () => {
    expect(adapterAccountDurableObjectName({ installationId: "singleton" }, "default"))
      .toBe("account:singleton:default");
    expect(() => parseAdapterAccountDurableObjectName("default")).toThrow("name is invalid");
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
    expect(parseAdapterAccountDurableObjectName(
      "account:inst_first:default%3Aaccount",
    )).toEqual({
      installationId: "inst_first",
      accountId: "default:account",
    });
  });

  it("rejects invalid installation identity", () => {
    expect(() => parseAdapterInstallationContext({ installationId: "../other" }))
      .toThrow("Adapter installation context is invalid");
  });

  it("rejects malformed scoped identities", () => {
    expect(() => parseAdapterAccountDurableObjectName("account:default"))
      .toThrow("name is invalid");
    expect(() => parseAdapterAccountDurableObjectName("account:inst_first:"))
      .toThrow("name is invalid");
    expect(() => parseAdapterAccountDurableObjectName("account:inst_first:%"))
      .toThrow("name is invalid");
    expect(() => parseAdapterAccountDurableObjectName(
      "account:inst_first:%64efault",
    )).toThrow("name is invalid");
  });



  it("rejects names Cloudflare cannot expose through ctx.id.name", () => {
    expect(() => adapterAccountDurableObjectName(
      { installationId: "inst_first" },
      "a".repeat(1_025),
    )).toThrow("Adapter account Durable Object name is too long");
    expect(() => parseAdapterAccountDurableObjectName("a".repeat(1_025)))
      .toThrow("Adapter account Durable Object name is too long");
  });




});
