import { describe, expect, it } from "vitest";
import type { RequestFrame } from "../protocol/frames";
import { ledgerArgsOf } from "./ledger";

const frame = (call: string, args: object) => {
  // SAFETY: only the call and args matter here, and these calls take these args.
  return { type: "req", id: "request", call, args } as RequestFrame;
};

describe("what the ledger keeps of a call", () => {
  it("keeps a sender's signing secret out", () => {
    expect(ledgerArgsOf(frame("event.source.rotate", { name: "pay", secret: "whsec_private" }))).toEqual({ name: "pay" });
  });

  it("keeps an event's words out, since they are someone else's", () => {
    expect(ledgerArgsOf(frame("event.emit", { source: "feed", events: [{ title: "private", body: "private" }] }))).toEqual({ source: "feed" });
  });

  it("keeps an ordinary call's arguments", () => {
    expect(ledgerArgsOf(frame("event.source.update", { name: "feed", ship: "wake" }))).toEqual({ name: "feed", ship: "wake" });
  });
});
