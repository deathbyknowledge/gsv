import { describe, expect, it } from "vitest";
import type { ContactRequestRecord } from "@humansandmachines/gsv/protocol";
import { assertRequestTransition, isRequestTransitionAllowed } from "./requests";

describe("request participant authority", () => {
  it("gives mirrored participants the same rights without letting the requester settle performed work", () => {
    expect(isRequestTransitionAllowed({ direction: "outgoing", state: "offered" }, "cancelled", "local")).toBe(true);
    expect(isRequestTransitionAllowed({ direction: "incoming", state: "offered" }, "cancelled", "remote")).toBe(true);
    expect(isRequestTransitionAllowed({ direction: "incoming", state: "offered" }, "accepted", "local")).toBe(true);
    expect(isRequestTransitionAllowed({ direction: "outgoing", state: "offered" }, "accepted", "remote")).toBe(true);
    expect(isRequestTransitionAllowed({ direction: "incoming", state: "active" }, "completed", "local")).toBe(true);
    expect(isRequestTransitionAllowed({ direction: "outgoing", state: "active" }, "completed", "remote")).toBe(true);
    expect(isRequestTransitionAllowed({ direction: "outgoing", state: "active" }, "cancelled", "local")).toBe(false);
    expect(isRequestTransitionAllowed({ direction: "incoming", state: "active" }, "cancelled", "remote")).toBe(false);
  });

  it("does not build another local revision on an unacknowledged v1 change", () => {
    const request: ContactRequestRecord = {
      id: "request:one", contactId: "contact:one", contactGeneration: "generation:one",
      direction: "incoming", kind: "task", title: "Help", state: "accepted", revision: 2,
      createdAtMs: 1, updatedAtMs: 2, exchange: { state: "pending", deliveryId: "delivery:accept" },
    };
    expect(() => assertRequestTransition(request, "completed")).toThrow("has not been confirmed");
    expect(() => assertRequestTransition({ ...request, exchange: { state: "failed" } }, "completed"))
      .toThrow("has not been confirmed");
    expect(() => assertRequestTransition({ ...request, exchange: { state: "acknowledged" } }, "completed"))
      .not.toThrow();
  });
});
