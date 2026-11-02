import { describe, expect, it } from "vitest";
import { ledgerArgsOf } from "./ledger";

describe("what the ledger keeps of a call", () => {
  it("keeps a sender's signing secret out", () => {
    expect(ledgerArgsOf({ type: "req", id: "r", call: "event.source.rotate", args: { name: "pay", secret: "whsec_private" } })).toEqual({ name: "pay" });
  });

  it("keeps a signing secret given when adding a source out, and the rest of the source's arguments", () => {
    expect(ledgerArgsOf({ type: "req", id: "r", call: "event.source.add", args: {
      name: "pay", webhook: "hmac", hmac: { header: "stripe-signature", encoding: "hex" }, secret: "whsec_private",
    } })).toEqual({ name: "pay", webhook: "hmac", hmac: { header: "stripe-signature", encoding: "hex" } });
  });

  it("keeps an event's words out, since they are someone else's", () => {
    expect(ledgerArgsOf({ type: "req", id: "r", call: "event.emit", args: { source: "feed", events: [{ title: "private", body: "private" }] } })).toEqual({ source: "feed" });
  });

  it("keeps an ordinary call's arguments", () => {
    expect(ledgerArgsOf({ type: "req", id: "r", call: "event.source.update", args: { name: "feed", ship: "wake" } })).toEqual({ name: "feed", ship: "wake" });
  });
});
